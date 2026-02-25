/**
 * Subscriptions Router
 *
 * Handles feed subscriptions: list, create, update, delete, import, export.
 * Implements subscription management with soft delete pattern.
 */

import { z } from "zod";
import { eq, and, isNull, sql, inArray } from "drizzle-orm";

import { createTRPCRouter, protectedProcedure, expensiveProtectedProcedure } from "../trpc";
import { errors } from "../errors";
import { feedUrlSchema, uuidSchema } from "../validation";
import { fetchUrl, isHtmlContent } from "@/server/http/fetch";
import {
  feeds,
  subscriptions,
  subscriptionFeeds,
  entries,
  userEntries,
  tags,
  subscriptionTags,
  blockedSenders,
  opmlImports,
  userFeeds,
  type OpmlImportFeedData,
} from "@/server/db/schema";
import { generateUuidv7 } from "@/lib/uuidv7";
import { parseFeed } from "@/server/feed/parser";
import { discoverFeeds } from "@/server/feed/discovery";
import { deriveGuid } from "@/server/feed/entry-processor";
import { getDomainFromUrl } from "@/server/feed/types";
import { extractUserIdFromFeedUrl, fetchLessWrongUserById } from "@/server/feed/lesswrong";
import { parseOpml, generateOpml, type OpmlFeed, type OpmlSubscription } from "@/server/feed/opml";
import { ensureFeedJob, createJob } from "@/server/jobs/queue";
import {
  publishSubscriptionCreated,
  publishSubscriptionDeleted,
  publishSubscriptionUpdated,
} from "@/server/redis/pubsub";
import { attemptUnsubscribe, getLatestUnsubscribeMailto } from "@/server/email/unsubscribe";
import { logger } from "@/lib/logger";
import * as subscriptionsService from "@/server/services/subscriptions";
import { usageLimitsConfig } from "@/server/config/env";

// ============================================================================
// Validation Schemas
// ============================================================================

/**
 * Custom title validation schema.
 */
const customTitleSchema = z
  .string()
  .max(255, "Custom title must be less than 255 characters")
  .nullable();

// ============================================================================
// Output Schemas
// ============================================================================

/**
 * Tag output schema for subscriptions - lightweight tag info.
 */
const tagOutputSchema = z.object({
  id: z.string(),
  name: z.string(),
  color: z.string().nullable(),
});

/**
 * Flat subscription output schema - subscription with feed metadata merged.
 * Uses subscription.id as the primary key, hiding internal feedId from clients.
 */
const subscriptionOutputSchema = z.object({
  id: z.string(), // subscription ID (primary key)
  type: z.enum(["web", "email", "saved"]),
  url: z.string().nullable(),
  title: z.string().nullable(), // resolved title (custom or original)
  originalTitle: z.string().nullable(), // feed's original title for rename UI
  description: z.string().nullable(),
  siteUrl: z.string().nullable(),
  subscribedAt: z.date(),
  unreadCount: z.number(),
  tags: z.array(tagOutputSchema),
  fetchFullContent: z.boolean(), // whether to fetch full article content from URL
});

// ============================================================================
// Subscription Helpers
// ============================================================================

/**
 * Parameters for creating or reactivating a subscription.
 */
interface CreateSubscriptionParams {
  /** User ID */
  userId: string;
  /** Feed ID to subscribe to */
  feedId: string;
  /**
   * How to find entries to populate user_entries:
   * - "lastSeenAt": Use feed's lastEntriesUpdatedAt to find current entries (for existing feeds)
   * - "guids": Use provided GUIDs to find entries (for freshly parsed feeds)
   * - "none": Don't populate entries (feed hasn't been fetched yet)
   */
  entrySource:
    | { type: "lastSeenAt"; lastEntriesUpdatedAt: Date | null }
    | { type: "guids"; guids: string[] }
    | { type: "none" };
}

/**
 * Result of creating or reactivating a subscription.
 */
interface CreateSubscriptionResult {
  /** Subscription ID */
  subscriptionId: string;
  /** When the subscription was created/reactivated */
  subscribedAt: Date;
  /** Whether this was a reactivation of a soft-deleted subscription */
  isReactivated: boolean;
  /** Number of unread entries populated */
  unreadCount: number;
}

/**
 * Creates a new subscription or reactivates a soft-deleted one.
 *
 * This centralizes subscription creation logic that was previously duplicated
 * in subscribeToExistingFeed, subscribeToNewOrUnfetchedFeed, and OPML import.
 *
 * Handles:
 * - Checking for existing subscription (throws if already active)
 * - Reactivating soft-deleted subscriptions
 * - Creating new subscriptions
 * - Populating user_entries for initial unread entries
 *
 * @param db - Database instance
 * @param params - Subscription parameters
 * @returns Subscription info including unread count
 * @throws alreadySubscribed if user already has an active subscription to this feed
 */
export async function createOrReactivateSubscription(
  db: typeof import("@/server/db").db,
  params: CreateSubscriptionParams
): Promise<CreateSubscriptionResult> {
  const { userId, feedId, entrySource } = params;

  // Check for existing subscription
  const existingSubscription = await db
    .select()
    .from(subscriptions)
    .where(and(eq(subscriptions.userId, userId), eq(subscriptions.feedId, feedId)))
    .limit(1);

  let subscriptionId: string;
  let subscribedAt: Date;
  let isReactivated = false;

  if (existingSubscription.length > 0) {
    const sub = existingSubscription[0];

    if (sub.unsubscribedAt === null) {
      throw errors.alreadySubscribed();
    }

    // Reactivate soft-deleted subscription (no count check needed - user already had this slot)
    subscriptionId = sub.id;
    subscribedAt = new Date();
    isReactivated = true;

    await db
      .update(subscriptions)
      .set({
        unsubscribedAt: null,
        subscribedAt,
        updatedAt: subscribedAt,
      })
      .where(eq(subscriptions.id, subscriptionId));
  } else {
    // Enforce subscription count limit before creating a new subscription
    const maxSubs = usageLimitsConfig.maxSubscriptionsPerUser;
    const [{ activeCount }] = await db
      .select({ activeCount: sql<number>`count(*)::int` })
      .from(subscriptions)
      .where(and(eq(subscriptions.userId, userId), isNull(subscriptions.unsubscribedAt)));

    if (activeCount >= maxSubs) {
      throw errors.maxSubscriptionsReached(maxSubs);
    }

    // Create new subscription
    subscriptionId = generateUuidv7();
    subscribedAt = new Date();

    await db.insert(subscriptions).values({
      id: subscriptionId,
      userId,
      feedId,
      subscribedAt,
      createdAt: subscribedAt,
      updatedAt: subscribedAt,
    });

    // Add the feed to the subscription_feeds junction table
    await db
      .insert(subscriptionFeeds)
      .values({ subscriptionId, feedId, userId })
      .onConflictDoNothing();
  }

  // Populate user_entries for initial unread entries
  let unreadCount = 0;

  if (entrySource.type === "lastSeenAt" && entrySource.lastEntriesUpdatedAt) {
    // Find entries currently in the feed using lastSeenAt timestamp matching
    const matchingEntries = await db
      .select({ id: entries.id })
      .from(entries)
      .where(
        and(eq(entries.feedId, feedId), eq(entries.lastSeenAt, entrySource.lastEntriesUpdatedAt))
      );

    if (matchingEntries.length > 0) {
      const pairs = matchingEntries.map((entry) => ({
        userId,
        entryId: entry.id,
      }));

      await db.insert(userEntries).values(pairs).onConflictDoNothing();
      unreadCount = matchingEntries.length;

      logger.debug("Populated initial user entries via lastSeenAt", {
        userId,
        feedId,
        entryCount: matchingEntries.length,
      });
    }
  } else if (entrySource.type === "guids" && entrySource.guids.length > 0) {
    // Find entries by GUID matching (for freshly parsed feeds)
    const matchingEntries = await db
      .select({ id: entries.id })
      .from(entries)
      .where(and(eq(entries.feedId, feedId), inArray(entries.guid, entrySource.guids)));

    if (matchingEntries.length > 0) {
      const pairs = matchingEntries.map((entry) => ({
        userId,
        entryId: entry.id,
      }));

      await db.insert(userEntries).values(pairs).onConflictDoNothing();
      unreadCount = matchingEntries.length;

      logger.debug("Populated initial user entries via GUIDs", {
        userId,
        feedId,
        entryCount: matchingEntries.length,
      });
    }
  }
  // type === "none": Don't populate entries (feed hasn't been fetched yet)

  return {
    subscriptionId,
    subscribedAt,
    isReactivated,
    unreadCount,
  };
}

/**
 * Subscribe to an existing feed that has already been fetched.
 * Uses lastSeenAt to determine which entries are currently in the feed,
 * avoiding an unnecessary network request.
 */
async function subscribeToExistingFeed(
  db: typeof import("@/server/db").db,
  userId: string,
  feedRecord: typeof feeds.$inferSelect
): Promise<z.infer<typeof subscriptionOutputSchema>> {
  const feedId = feedRecord.id;

  // Ensure job exists and sync next_fetch_at
  const job = await ensureFeedJob(feedId);
  if (job.nextRunAt) {
    await db
      .update(feeds)
      .set({ nextFetchAt: job.nextRunAt, updatedAt: new Date() })
      .where(eq(feeds.id, feedId));
  }

  // Create or reactivate subscription with entry population via lastSeenAt
  const result = await createOrReactivateSubscription(db, {
    userId,
    feedId,
    entrySource: {
      type: "lastSeenAt",
      lastEntriesUpdatedAt: feedRecord.lastEntriesUpdatedAt,
    },
  });

  const feedData = {
    id: feedRecord.id,
    type: feedRecord.type,
    url: feedRecord.url,
    title: feedRecord.title,
    description: feedRecord.description,
    siteUrl: feedRecord.siteUrl,
  };

  // SSE event uses nested format for compatibility
  const sseSubscriptionData = {
    id: result.subscriptionId,
    feedId,
    customTitle: null,
    subscribedAt: result.subscribedAt.toISOString(),
    unreadCount: result.unreadCount,
    tags: [] as Array<{ id: string; name: string; color: string | null }>,
  };

  publishSubscriptionCreated(
    userId,
    feedId,
    result.subscriptionId,
    result.subscribedAt, // subscribedAt is used for both subscribedAt and updatedAt
    sseSubscriptionData,
    feedData
  ).catch((err) => {
    logger.error("Failed to publish subscription_created event", { err, userId, feedId });
  });

  // Return flat format for API response
  return {
    id: result.subscriptionId,
    type: feedRecord.type,
    url: feedRecord.url,
    title: feedRecord.title, // no custom title for new subscriptions
    originalTitle: feedRecord.title,
    description: feedRecord.description,
    siteUrl: feedRecord.siteUrl,
    subscribedAt: result.subscribedAt,
    unreadCount: result.unreadCount,
    tags: [] as Array<{ id: string; name: string; color: string | null }>,
    fetchFullContent: false, // default for new subscriptions
  };
}

/**
 * Subscribe to a new feed or one that hasn't been fetched yet.
 * Requires fetching the URL to discover/parse the feed.
 */
async function subscribeToNewOrUnfetchedFeed(
  db: typeof import("@/server/db").db,
  userId: string,
  inputUrl: string
): Promise<z.infer<typeof subscriptionOutputSchema>> {
  let feedUrl = inputUrl;

  // Fetch the URL
  const { text: content, contentType, finalUrl: initialFinalUrl } = await fetchUrl(feedUrl);

  // If HTML, try to discover feeds
  let feedContent: string;
  let finalFeedUrl: string;
  if (isHtmlContent(contentType, content)) {
    const discoveredFeeds = discoverFeeds(content, initialFinalUrl);

    if (discoveredFeeds.length === 0) {
      throw errors.validation("No feeds found at this URL");
    }

    // Use the first discovered feed
    feedUrl = discoveredFeeds[0].url;

    // Check if the discovered feed URL exists and has been fetched
    const existingDiscoveredFeed = await db
      .select()
      .from(feeds)
      .where(eq(feeds.url, feedUrl))
      .limit(1);

    if (existingDiscoveredFeed.length > 0 && existingDiscoveredFeed[0].lastFetchedAt !== null) {
      // The discovered feed is already known - use fast path
      return await subscribeToExistingFeed(
        db,
        userId,
        existingDiscoveredFeed[0] as typeof feeds.$inferSelect
      );
    }

    // Fetch the discovered feed URL
    const discoveredFetch = await fetchUrl(feedUrl);
    feedContent = discoveredFetch.text;
    finalFeedUrl = discoveredFetch.finalUrl;
  } else {
    feedContent = content;
    finalFeedUrl = initialFinalUrl;
  }

  // Parse the feed
  let parsedFeed;
  try {
    parsedFeed = parseFeed(feedContent);
  } catch {
    throw errors.validation("Could not parse feed - make sure it's a valid RSS or Atom feed");
  }

  // Use final URL after redirects
  feedUrl = finalFeedUrl;

  // Check if feed already exists (by final URL)
  const existingFeed = await db.select().from(feeds).where(eq(feeds.url, feedUrl)).limit(1);

  let feedId: string;
  let feedRecord: typeof feeds.$inferSelect;

  if (existingFeed.length > 0) {
    feedId = existingFeed[0].id;
    feedRecord = existingFeed[0];

    // Ensure job exists
    const job = await ensureFeedJob(feedId);
    if (job.nextRunAt) {
      await db
        .update(feeds)
        .set({ nextFetchAt: job.nextRunAt, updatedAt: new Date() })
        .where(eq(feeds.id, feedId));
    }
  } else {
    // Create new feed
    feedId = generateUuidv7();
    const now = new Date();

    // Use domain as title fallback, but also check for LessWrong user feeds
    let feedTitle = parsedFeed.title || getDomainFromUrl(feedUrl);
    const lessWrongUserId = extractUserIdFromFeedUrl(feedUrl);
    if (lessWrongUserId && feedTitle) {
      // Fetch LessWrong user info and append display name to title
      const lwUser = await fetchLessWrongUserById(lessWrongUserId);
      if (lwUser?.displayName) {
        feedTitle = `${feedTitle} - ${lwUser.displayName}`;
      }
    }

    const newFeed = {
      id: feedId,
      type: "web" as const, // All URL-based feeds use "web" type
      url: feedUrl,
      title: feedTitle,
      description: parsedFeed.description || null,
      siteUrl: parsedFeed.siteUrl || null,
      nextFetchAt: now,
      createdAt: now,
      updatedAt: now,
    };

    await db.insert(feeds).values(newFeed);
    feedRecord = newFeed as typeof feeds.$inferSelect;

    await ensureFeedJob(feedId);
  }

  // Extract GUIDs from parsed feed for entry matching
  const feedGuids: string[] = [];
  for (const item of parsedFeed.items) {
    try {
      feedGuids.push(deriveGuid(item));
    } catch {
      // Skip items without valid GUIDs
    }
  }

  // Create or reactivate subscription with entry population via GUIDs
  const result = await createOrReactivateSubscription(db, {
    userId,
    feedId,
    entrySource: {
      type: "guids",
      guids: feedGuids,
    },
  });

  const feedData = {
    id: feedRecord.id,
    type: feedRecord.type,
    url: feedRecord.url,
    title: feedRecord.title,
    description: feedRecord.description,
    siteUrl: feedRecord.siteUrl,
  };

  // SSE event uses nested format for compatibility
  const sseSubscriptionData = {
    id: result.subscriptionId,
    feedId,
    customTitle: null,
    subscribedAt: result.subscribedAt.toISOString(),
    unreadCount: result.unreadCount,
    tags: [] as Array<{ id: string; name: string; color: string | null }>,
  };

  publishSubscriptionCreated(
    userId,
    feedId,
    result.subscriptionId,
    result.subscribedAt, // subscribedAt is used for both subscribedAt and updatedAt
    sseSubscriptionData,
    feedData
  ).catch((err) => {
    logger.error("Failed to publish subscription_created event", { err, userId, feedId });
  });

  // Return flat format for API response
  return {
    id: result.subscriptionId,
    type: feedRecord.type,
    url: feedRecord.url,
    title: feedRecord.title, // no custom title for new subscriptions
    originalTitle: feedRecord.title,
    description: feedRecord.description,
    siteUrl: feedRecord.siteUrl,
    subscribedAt: result.subscribedAt,
    unreadCount: result.unreadCount,
    tags: [] as Array<{ id: string; name: string; color: string | null }>,
    fetchFullContent: false, // default for new subscriptions
  };
}

// ============================================================================
// Router
// ============================================================================

export const subscriptionsRouter = createTRPCRouter({
  /**
   * Subscribe to a feed by URL.
   *
   * This procedure:
   * 1. Fetches the URL content
   * 2. If HTML, discovers feeds and uses the first one
   * 3. Parses the feed to get metadata
   * 4. Creates or finds the existing feed record
   * 5. Creates the subscription (or reactivates if previously unsubscribed)
   *
   * @param url - The feed URL (or HTML page with feed discovery)
   * @returns The subscription and feed
   *
   * Note: This endpoint uses stricter rate limiting (10 burst, 1/sec)
   * since it involves external HTTP requests.
   */
  create: expensiveProtectedProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/subscriptions",
        tags: ["Subscriptions"],
        summary: "Subscribe to a feed",
      },
    })
    .input(
      z.object({
        url: feedUrlSchema,
      })
    )
    .output(subscriptionOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;
      const feedUrl = input.url;

      // Check if this exact URL already exists as a feed that's been fetched
      // If so, we can skip the network request and use lastSeenAt to determine visibility
      const existingFeedByUrl = await ctx.db
        .select()
        .from(feeds)
        .where(eq(feeds.url, feedUrl))
        .limit(1);

      const canSkipFetch =
        existingFeedByUrl.length > 0 && existingFeedByUrl[0].lastFetchedAt !== null;

      if (canSkipFetch) {
        // Fast path: existing feed that's been fetched - no network request needed
        return await subscribeToExistingFeed(
          ctx.db,
          userId,
          existingFeedByUrl[0] as typeof feeds.$inferSelect
        );
      }

      // Slow path: need to fetch and potentially discover the feed
      return await subscribeToNewOrUnfetchedFeed(ctx.db, userId, feedUrl);
    }),

  /**
   * List all active subscriptions for the current user.
   *
   * Supports optional filtering and pagination:
   * - query: Case-insensitive title search (substring matching)
   * - tagId: Filter by tag
   * - uncategorized: Only show subscriptions with no tags
   * - unreadOnly: Only show feeds with unread items
   * - cursor/limit: Cursor-based pagination (max 100 per page)
   *
   * Returns subscriptions with their associated feed information and unread counts.
   */
  list: protectedProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/subscriptions",
        tags: ["Subscriptions"],
        summary: "List subscriptions",
      },
    })
    .input(
      z
        .object({
          query: z.string().optional(),
          tagId: z.string().uuid().optional(),
          uncategorized: z.boolean().optional(),
          unreadOnly: z.boolean().optional(),
          cursor: z.string().optional(),
          limit: z.number().min(1).max(100).optional(),
        })
        .optional()
    )
    .output(
      z.object({
        items: z.array(subscriptionOutputSchema),
        nextCursor: z.string().optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;
      const result = await subscriptionsService.listSubscriptions(ctx.db, {
        userId,
        ...input,
      });
      return { items: result.subscriptions, nextCursor: result.nextCursor };
    }),

  /**
   * Get a single subscription by ID.
   *
   * Returns the subscription with its associated feed information and unread count.
   */
  get: protectedProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/subscriptions/{id}",
        tags: ["Subscriptions"],
        summary: "Get subscription",
      },
    })
    .input(
      z.object({
        id: uuidSchema,
      })
    )
    .output(subscriptionOutputSchema)
    .query(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;
      return subscriptionsService.getSubscription(ctx.db, userId, input.id);
    }),

  /**
   * Update a subscription.
   *
   * Allows users to update subscription settings:
   * - customTitle: Set a custom title (null to use feed's default)
   * - fetchFullContent: Whether to fetch full article content from URL
   */
  update: protectedProcedure
    .meta({
      openapi: {
        method: "PATCH",
        path: "/subscriptions/{id}",
        tags: ["Subscriptions"],
        summary: "Update subscription",
      },
    })
    .input(
      z.object({
        id: uuidSchema,
        customTitle: customTitleSchema.optional(),
        fetchFullContent: z.boolean().optional(),
      })
    )
    .output(subscriptionOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;

      // Update the subscription and return key fields (WHERE clause ensures ownership)
      const now = new Date();
      const updateData: {
        updatedAt: Date;
        customTitle?: string | null;
        fetchFullContent?: boolean;
      } = {
        updatedAt: now,
      };

      if (input.customTitle !== undefined) {
        updateData.customTitle = input.customTitle;
      }
      if (input.fetchFullContent !== undefined) {
        updateData.fetchFullContent = input.fetchFullContent;
      }

      const updateResult = await ctx.db
        .update(subscriptions)
        .set(updateData)
        .where(
          and(
            eq(subscriptions.id, input.id),
            eq(subscriptions.userId, userId),
            isNull(subscriptions.unsubscribedAt)
          )
        )
        .returning({
          id: subscriptions.id,
          feedId: subscriptions.feedId,
          customTitle: subscriptions.customTitle,
          fetchFullContent: subscriptions.fetchFullContent,
          subscribedAt: subscriptions.subscribedAt,
        });

      if (updateResult.length === 0) {
        throw errors.subscriptionNotFound();
      }

      const subscription = updateResult[0];

      // Fetch feed, tags, and unread count in separate queries to avoid
      // cross-join between tags and entries that multiplies COUNT results (#680).
      const [feedResult, tagsResult, unreadResult] = await Promise.all([
        // Feed metadata
        ctx.db
          .select({
            id: feeds.id,
            type: feeds.type,
            url: feeds.url,
            title: feeds.title,
            description: feeds.description,
            siteUrl: feeds.siteUrl,
          })
          .from(feeds)
          .where(eq(feeds.id, subscription.feedId))
          .limit(1),

        // Tags for this subscription
        ctx.db
          .select({
            id: tags.id,
            name: tags.name,
            color: tags.color,
          })
          .from(subscriptionTags)
          .innerJoin(tags, eq(tags.id, subscriptionTags.tagId))
          .where(eq(subscriptionTags.subscriptionId, subscription.id)),

        // Unread count
        ctx.db
          .select({
            count: sql<number>`COUNT(*) FILTER (WHERE ${userEntries.read} = false)::int`,
          })
          .from(entries)
          .innerJoin(
            userEntries,
            and(eq(userEntries.entryId, entries.id), eq(userEntries.userId, userId))
          )
          .where(eq(entries.feedId, subscription.feedId)),
      ]);

      const result = feedResult[0];
      if (!result) {
        throw errors.subscriptionNotFound();
      }

      const subscriptionTagsList = tagsResult.map((t) => ({
        id: t.id,
        name: t.name,
        color: t.color,
      }));
      const unreadCount = unreadResult[0]?.count ?? 0;

      // Publish SSE event for other tabs/devices
      publishSubscriptionUpdated(
        userId,
        subscription.id,
        now,
        subscriptionTagsList,
        subscription.customTitle
      ).catch((err) => {
        logger.error("Failed to publish subscription_updated event", {
          err,
          userId,
          subscriptionId: subscription.id,
        });
      });

      // Return flat format
      return {
        id: subscription.id,
        type: result.type,
        url: result.url,
        title: subscription.customTitle ?? result.title, // resolved title
        originalTitle: result.title,
        description: result.description,
        siteUrl: result.siteUrl,
        subscribedAt: subscription.subscribedAt,
        unreadCount,
        tags: subscriptionTagsList,
        fetchFullContent: subscription.fetchFullContent,
      };
    }),

  /**
   * Unsubscribe from a feed (soft delete).
   *
   * Sets unsubscribedAt timestamp instead of deleting the record.
   * This allows users to resubscribe later while preserving their read state.
   *
   * For email feeds, this also:
   * 1. Attempts to send an unsubscribe request (mailto or HTTPS)
   * 2. Adds the sender to the blocked_senders table
   */
  delete: protectedProcedure
    .meta({
      openapi: {
        method: "DELETE",
        path: "/subscriptions/{id}",
        tags: ["Subscriptions"],
        summary: "Unsubscribe from feed",
      },
    })
    .input(
      z.object({
        id: uuidSchema,
      })
    )
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;

      // Verify the subscription exists and belongs to the user, and get feed info
      const existing = await ctx.db
        .select({
          subscription: subscriptions,
          feed: feeds,
        })
        .from(subscriptions)
        .innerJoin(feeds, eq(subscriptions.feedId, feeds.id))
        .where(
          and(
            eq(subscriptions.id, input.id),
            eq(subscriptions.userId, userId),
            isNull(subscriptions.unsubscribedAt)
          )
        )
        .limit(1);

      if (existing.length === 0) {
        throw errors.subscriptionNotFound();
      }

      const { feed } = existing[0];
      const now = new Date();

      // Handle email feed unsubscription
      if (feed.type === "email" && feed.emailSenderPattern) {
        // 1. Attempt to send unsubscribe request
        const unsubscribeResult = await attemptUnsubscribe(feed.id);

        logger.info("Email unsubscribe attempt completed", {
          feedId: feed.id,
          userId,
          senderEmail: feed.emailSenderPattern,
          sent: unsubscribeResult.sent,
          method: unsubscribeResult.method,
        });

        // 2. Get the mailto URL used for unsubscribe (for potential retry)
        const listUnsubscribeMailto = await getLatestUnsubscribeMailto(feed.id);

        // 3. Add sender to blocked_senders table
        await ctx.db
          .insert(blockedSenders)
          .values({
            id: generateUuidv7(),
            userId,
            senderEmail: feed.emailSenderPattern,
            blockedAt: now,
            listUnsubscribeMailto,
            unsubscribeSentAt: unsubscribeResult.sent ? now : null,
          })
          .onConflictDoNothing(); // Handle case where sender is already blocked

        logger.info("Added sender to blocked list", {
          userId,
          senderEmail: feed.emailSenderPattern,
          unsubscribeSent: unsubscribeResult.sent,
        });
      }

      // Remove all tag associations so resubscribing starts fresh
      await ctx.db.delete(subscriptionTags).where(eq(subscriptionTags.subscriptionId, input.id));

      // Soft delete by setting unsubscribedAt
      await ctx.db
        .update(subscriptions)
        .set({
          unsubscribedAt: now,
          updatedAt: now,
        })
        .where(eq(subscriptions.id, input.id));

      // Publish subscription_deleted event so other tabs/windows can update
      publishSubscriptionDeleted(userId, feed.id, input.id, now).catch((err) => {
        logger.error("Failed to publish subscription_deleted event", {
          err,
          userId,
          feedId: feed.id,
        });
      });

      // Note: In the data-driven model, we don't need to disable the job.
      // The job will simply not be claimed if there are no active subscribers.

      return { success: true };
    }),

  /**
   * Import feeds from OPML content.
   *
   * This procedure:
   * 1. Parses the OPML XML content
   * 2. For each feed, creates or finds the existing feed record
   * 3. Creates subscriptions (skips already subscribed feeds)
   * 4. Returns import results with counts and errors
   *
   * @param opml - The OPML XML content as a string
   * @returns Import results with imported, skipped, and error counts
   */
  import: expensiveProtectedProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/subscriptions/import",
        tags: ["Subscriptions"],
        summary: "Import feeds from OPML",
      },
    })
    .input(
      z.object({
        opml: z
          .string()
          .min(1, "OPML content is required")
          .max(5 * 1024 * 1024, "OPML file too large (max 5MB)"),
      })
    )
    .output(
      z.object({
        importId: z.string(),
        totalFeeds: z.number(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;

      // Step 1: Parse the OPML content
      let opmlFeeds: OpmlFeed[];
      try {
        opmlFeeds = await parseOpml(input.opml);
      } catch (error) {
        throw errors.validation(
          `Failed to parse OPML: ${error instanceof Error ? error.message : "Invalid OPML format"}`
        );
      }

      if (opmlFeeds.length === 0) {
        // Create a completed import record with no feeds
        const importId = generateUuidv7();
        const now = new Date();

        await ctx.db.insert(opmlImports).values({
          id: importId,
          userId,
          status: "completed",
          totalFeeds: 0,
          importedCount: 0,
          skippedCount: 0,
          failedCount: 0,
          feedsData: [],
          results: [],
          completedAt: now,
          createdAt: now,
          updatedAt: now,
        });

        return {
          importId,
          totalFeeds: 0,
        };
      }

      // Step 2: Deduplicate feeds by URL, merging categories
      // This ensures a feed in 5 tags counts as 1 import, not 5
      const feedsByUrl = new Map<string, OpmlImportFeedData>();
      for (const feed of opmlFeeds) {
        const existing = feedsByUrl.get(feed.xmlUrl);
        if (existing) {
          // Merge categories (use first level of category path as tag)
          if (feed.category && feed.category.length > 0) {
            const tagName = feed.category[0]; // Use first level as tag
            if (!existing.category) {
              existing.category = [tagName];
            } else if (!existing.category.includes(tagName)) {
              existing.category.push(tagName);
            }
          }
          // Use title from first occurrence (don't overwrite)
        } else {
          feedsByUrl.set(feed.xmlUrl, {
            xmlUrl: feed.xmlUrl,
            title: feed.title,
            htmlUrl: feed.htmlUrl,
            // Use first level of category path as tag name
            category: feed.category && feed.category.length > 0 ? [feed.category[0]] : undefined,
          });
        }
      }

      const feedsData = Array.from(feedsByUrl.values());

      // Step 3: Create import record
      const importId = generateUuidv7();
      const now = new Date();

      await ctx.db.insert(opmlImports).values({
        id: importId,
        userId,
        status: "pending",
        totalFeeds: feedsData.length, // Use deduplicated count
        importedCount: 0,
        skippedCount: 0,
        failedCount: 0,
        feedsData,
        results: [],
        createdAt: now,
        updatedAt: now,
      });

      // Step 4: Queue background job to process the import
      await createJob({
        type: "process_opml_import",
        payload: { importId },
        nextRunAt: now, // Run immediately
      });

      logger.info("OPML import queued", {
        importId,
        userId,
        totalFeeds: feedsData.length,
        originalCount: opmlFeeds.length, // Log original for debugging
      });

      return {
        importId,
        totalFeeds: feedsData.length, // Return deduplicated count
      };
    }),

  /**
   * Export subscriptions as OPML.
   *
   * Generates an OPML XML file containing all active subscriptions
   * for the current user. Feeds are listed at the top level and
   * re-listed inside their tag folders.
   *
   * @returns OPML XML content
   */
  export: protectedProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/subscriptions/export",
        tags: ["Subscriptions"],
        summary: "Export subscriptions as OPML",
      },
    })
    .input(z.object({}).optional())
    .output(
      z.object({
        opml: z.string(),
        feedCount: z.number(),
      })
    )
    .query(async ({ ctx }) => {
      const userId = ctx.session.user.id;

      // Get all active subscriptions with feed info and tags using user_feeds view
      // View already filters out unsubscribed and resolves title
      const userSubscriptions = await ctx.db
        .select({
          id: userFeeds.id,
          title: userFeeds.title, // already resolved (custom or original)
          url: userFeeds.url,
          siteUrl: userFeeds.siteUrl,
          // Tags aggregated as JSON array
          tagNames: sql<string[]>`
            COALESCE(
              array_agg(${tags.name}) FILTER (WHERE ${tags.id} IS NOT NULL),
              '{}'::text[]
            )
          `,
        })
        .from(userFeeds)
        .leftJoin(subscriptionTags, eq(subscriptionTags.subscriptionId, userFeeds.id))
        .leftJoin(tags, eq(tags.id, subscriptionTags.tagId))
        .where(eq(userFeeds.userId, userId))
        .groupBy(userFeeds.id)
        .orderBy(userFeeds.title);

      // Convert to OPML subscription format
      const opmlSubscriptions: OpmlSubscription[] = userSubscriptions
        .filter((row) => row.url !== null)
        .map((row) => ({
          title: row.title || row.url || "Untitled Feed",
          xmlUrl: row.url!,
          htmlUrl: row.siteUrl ?? undefined,
          tags: row.tagNames.length > 0 ? row.tagNames : undefined,
        }));

      // Generate OPML
      const opml = generateOpml(opmlSubscriptions, {
        title: "Lion Reader Subscriptions",
      });

      logger.info("OPML export completed", {
        userId,
        feedCount: opmlSubscriptions.length,
      });

      return {
        opml,
        feedCount: opmlSubscriptions.length,
      };
    }),

  /**
   * Set tags for a subscription (replace all).
   *
   * This replaces all existing tags on the subscription with the provided tag IDs.
   * All tag IDs must belong to the current user.
   *
   * @param id - The subscription ID
   * @param tagIds - Array of tag IDs to set
   * @returns Empty object on success
   */
  setTags: protectedProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/subscriptions/{id}/tags",
        tags: ["Subscriptions"],
        summary: "Set subscription tags",
      },
    })
    .input(
      z.object({
        id: uuidSchema,
        tagIds: z.array(z.string().uuid("Invalid tag ID")),
      })
    )
    .output(z.object({}))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;

      // Verify the subscription exists and belongs to the user
      const existingSubscription = await ctx.db
        .select()
        .from(subscriptions)
        .where(
          and(
            eq(subscriptions.id, input.id),
            eq(subscriptions.userId, userId),
            isNull(subscriptions.unsubscribedAt)
          )
        )
        .limit(1);

      if (existingSubscription.length === 0) {
        throw errors.subscriptionNotFound();
      }

      const now = new Date();

      if (input.tagIds.length === 0) {
        // Delete all existing tags for the subscription
        await ctx.db.delete(subscriptionTags).where(eq(subscriptionTags.subscriptionId, input.id));

        // Update subscription's updated_at for sync cursor tracking
        await ctx.db
          .update(subscriptions)
          .set({ updatedAt: now })
          .where(eq(subscriptions.id, input.id));

        // Publish SSE event with empty tags
        publishSubscriptionUpdated(
          userId,
          input.id,
          now,
          [],
          existingSubscription[0].customTitle
        ).catch((err) => {
          logger.error("Failed to publish subscription_updated event", {
            err,
            userId,
            subscriptionId: input.id,
          });
        });

        return {};
      }

      // Verify all tag IDs belong to the current user and get tag details
      const userTags = await ctx.db
        .select({ id: tags.id, name: tags.name, color: tags.color })
        .from(tags)
        .where(and(eq(tags.userId, userId), inArray(tags.id, input.tagIds)));

      const validTagIds = new Set(userTags.map((t) => t.id));
      const invalidTagIds = input.tagIds.filter((id) => !validTagIds.has(id));

      if (invalidTagIds.length > 0) {
        throw errors.validation("One or more tag IDs are invalid or do not belong to you");
      }

      // Delete all existing tags for the subscription
      await ctx.db.delete(subscriptionTags).where(eq(subscriptionTags.subscriptionId, input.id));

      // Insert new subscription_tags entries
      await ctx.db.insert(subscriptionTags).values(
        input.tagIds.map((tagId) => ({
          subscriptionId: input.id,
          tagId,
          createdAt: now,
        }))
      );

      // Update subscription's updated_at for sync cursor tracking
      await ctx.db
        .update(subscriptions)
        .set({ updatedAt: now })
        .where(eq(subscriptions.id, input.id));

      // Publish SSE event with new tags
      const tagsList = userTags.map((t) => ({
        id: t.id,
        name: t.name,
        color: t.color,
      }));

      publishSubscriptionUpdated(
        userId,
        input.id,
        now,
        tagsList,
        existingSubscription[0].customTitle
      ).catch((err) => {
        logger.error("Failed to publish subscription_updated event", {
          err,
          userId,
          subscriptionId: input.id,
        });
      });

      return {};
    }),
});

// Export helper for use in background job handlers

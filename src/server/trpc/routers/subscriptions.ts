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
import {
  feeds,
  subscriptions,
  entries,
  userEntries,
  tags,
  subscriptionTags,
} from "@/server/db/schema";
import { generateUuidv7 } from "@/lib/uuidv7";
import { parseFeed, discoverFeeds, detectFeedType, deriveGuid } from "@/server/feed";
import { parseOpml, generateOpml, type OpmlFeed, type OpmlSubscription } from "@/server/feed/opml";
import { createInitialFetchJob } from "@/server/jobs/handlers";
import { publishSubscriptionCreated } from "@/server/redis/pubsub";
import { logger } from "@/lib/logger";
import type { FeedType } from "@/server/feed";

// ============================================================================
// Constants
// ============================================================================

/**
 * User-Agent header sent when fetching feeds.
 */
const USER_AGENT = "LionReader/1.0 (+https://lionreader.com/bot)";

/**
 * Timeout for feed fetch requests (10 seconds).
 */
const FETCH_TIMEOUT_MS = 10000;

// ============================================================================
// Validation Schemas
// ============================================================================

/**
 * URL validation schema for feed subscription.
 */
const urlSchema = z
  .string()
  .min(1, "URL is required")
  .max(2048, "URL must be less than 2048 characters")
  .url("Invalid URL format")
  .refine((url) => url.startsWith("http://") || url.startsWith("https://"), {
    message: "URL must use http or https protocol",
  });

/**
 * UUID validation schema for subscription IDs.
 */
const uuidSchema = z.string().uuid("Invalid subscription ID");

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
 * Feed output schema - what we return for a feed.
 */
const feedOutputSchema = z.object({
  id: z.string(),
  type: z.enum(["rss", "atom", "json"]),
  url: z.string().nullable(),
  title: z.string().nullable(),
  description: z.string().nullable(),
  siteUrl: z.string().nullable(),
});

/**
 * Subscription output schema - what we return for a subscription.
 */
const subscriptionOutputSchema = z.object({
  id: z.string(),
  feedId: z.string(),
  customTitle: z.string().nullable(),
  subscribedAt: z.date(),
  unreadCount: z.number(),
  tags: z.array(tagOutputSchema),
});

/**
 * Subscription with feed output schema.
 */
const subscriptionWithFeedOutputSchema = z.object({
  subscription: subscriptionOutputSchema,
  feed: feedOutputSchema,
});

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Fetches content from a URL with proper error handling.
 *
 * @param url - The URL to fetch
 * @returns The response with text content
 */
async function fetchUrl(url: string): Promise<{ text: string; contentType: string }> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
      },
      signal: controller.signal,
      redirect: "follow",
    });

    if (!response.ok) {
      throw errors.feedFetchError(url, `HTTP ${response.status}`);
    }

    const text = await response.text();
    const contentType = response.headers.get("content-type") ?? "";

    return { text, contentType };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw errors.feedFetchError(url, "Request timed out");
    }
    if (error instanceof Error && "code" in error) {
      // This is already a TRPCError
      throw error;
    }
    throw errors.feedFetchError(url, error instanceof Error ? error.message : "Unknown error");
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Determines if content is HTML (for feed discovery) or a feed.
 *
 * @param contentType - The content type header
 * @param content - The content body
 * @returns true if the content is HTML
 */
function isHtmlContent(contentType: string, content: string): boolean {
  // Check content type header
  if (contentType.includes("text/html") || contentType.includes("application/xhtml+xml")) {
    return true;
  }

  // Fallback: check content itself
  const trimmed = content.trim().toLowerCase();
  return trimmed.startsWith("<!doctype html") || trimmed.startsWith("<html");
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
        url: urlSchema,
      })
    )
    .output(subscriptionWithFeedOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;
      let feedUrl = input.url;

      // Step 1: Fetch the URL
      const { text: content, contentType } = await fetchUrl(feedUrl);

      // Step 2: If HTML, try to discover feeds
      let feedContent: string;
      if (isHtmlContent(contentType, content)) {
        const discoveredFeeds = discoverFeeds(content, feedUrl);

        if (discoveredFeeds.length === 0) {
          throw errors.validation("No feeds found at this URL");
        }

        // Use the first discovered feed
        feedUrl = discoveredFeeds[0].url;

        // Fetch the actual feed
        const feedResult = await fetchUrl(feedUrl);
        feedContent = feedResult.text;
      } else {
        feedContent = content;
      }

      // Step 3: Parse the feed
      let parsedFeed;
      try {
        parsedFeed = parseFeed(feedContent);
      } catch (error) {
        throw errors.parseError(error instanceof Error ? error.message : "Invalid feed format");
      }

      // Step 4: Check if feed already exists
      const existingFeed = await ctx.db.select().from(feeds).where(eq(feeds.url, feedUrl)).limit(1);

      let feedId: string;
      let feedRecord: typeof feeds.$inferSelect;

      if (existingFeed.length > 0) {
        // Feed exists - use it
        feedId = existingFeed[0].id;
        feedRecord = existingFeed[0];
      } else {
        // Create new feed
        feedId = generateUuidv7();
        const feedType = detectFeedType(feedContent) as FeedType;
        const now = new Date();

        const newFeed = {
          id: feedId,
          type: feedType === "unknown" ? "rss" : feedType, // Default to RSS if unknown
          url: feedUrl,
          title: parsedFeed.title || null,
          description: parsedFeed.description || null,
          siteUrl: parsedFeed.siteUrl || null,
          nextFetchAt: now, // Schedule immediate fetch
          createdAt: now,
          updatedAt: now,
        };

        await ctx.db.insert(feeds).values(newFeed);
        feedRecord = newFeed as typeof feeds.$inferSelect;

        // Schedule initial fetch job for the new feed
        await createInitialFetchJob(feedId);
      }

      // Step 5: Check for existing subscription
      const existingSubscription = await ctx.db
        .select()
        .from(subscriptions)
        .where(and(eq(subscriptions.userId, userId), eq(subscriptions.feedId, feedId)))
        .limit(1);

      let subscriptionId: string;
      let subscribedAt: Date;

      if (existingSubscription.length > 0) {
        const sub = existingSubscription[0];

        if (sub.unsubscribedAt === null) {
          // Already subscribed and active
          throw errors.alreadySubscribed();
        }

        // Reactivate subscription
        subscriptionId = sub.id;
        subscribedAt = new Date();

        await ctx.db
          .update(subscriptions)
          .set({
            unsubscribedAt: null,
            subscribedAt: subscribedAt,
            updatedAt: subscribedAt,
          })
          .where(eq(subscriptions.id, subscriptionId));
      } else {
        // Create new subscription
        subscriptionId = generateUuidv7();
        subscribedAt = new Date();

        await ctx.db.insert(subscriptions).values({
          id: subscriptionId,
          userId,
          feedId,
          subscribedAt,
          createdAt: subscribedAt,
          updatedAt: subscribedAt,
        });
      }

      // Step 6: Populate user_entries for entries currently in the feed
      // This makes existing entries visible to the new subscriber
      const feedGuids: string[] = [];
      for (const item of parsedFeed.items) {
        try {
          feedGuids.push(deriveGuid(item));
        } catch {
          // Skip items without valid GUIDs
        }
      }

      let unreadCount = 0;
      if (feedGuids.length > 0) {
        // Find entries that exist in our database and match the current feed
        const matchingEntries = await ctx.db
          .select({ id: entries.id })
          .from(entries)
          .where(and(eq(entries.feedId, feedId), inArray(entries.guid, feedGuids)));

        if (matchingEntries.length > 0) {
          // Insert user_entries for all matching entries
          const pairs = matchingEntries.map((entry) => ({
            userId,
            entryId: entry.id,
          }));

          // Bulk insert with ON CONFLICT DO NOTHING (for resubscription case)
          await ctx.db.insert(userEntries).values(pairs).onConflictDoNothing();

          // All these entries are unread for a new subscription
          unreadCount = matchingEntries.length;

          logger.debug("Populated initial user entries", {
            userId,
            feedId,
            entryCount: matchingEntries.length,
          });
        }
      }

      // Publish subscription_created event to notify all of the user's SSE connections
      // This ensures other browser tabs/devices will receive new_entry events for this feed
      publishSubscriptionCreated(userId, feedId, subscriptionId).catch((err) => {
        logger.error("Failed to publish subscription_created event", { err, userId, feedId });
      });

      return {
        subscription: {
          id: subscriptionId,
          feedId,
          customTitle: null,
          subscribedAt,
          unreadCount,
          tags: [], // New subscription has no tags yet
        },
        feed: {
          id: feedRecord.id,
          type: feedRecord.type,
          url: feedRecord.url,
          title: feedRecord.title,
          description: feedRecord.description,
          siteUrl: feedRecord.siteUrl,
        },
      };
    }),

  /**
   * List all active subscriptions for the current user.
   *
   * Returns subscriptions with their associated feed information and unread counts.
   * Subscriptions are ordered by feed title (ascending).
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
    .input(z.object({}).optional())
    .output(
      z.object({
        items: z.array(subscriptionWithFeedOutputSchema),
      })
    )
    .query(async ({ ctx }) => {
      const userId = ctx.session.user.id;

      // Get all active subscriptions with feed info
      const userSubscriptions = await ctx.db
        .select({
          subscription: subscriptions,
          feed: feeds,
        })
        .from(subscriptions)
        .innerJoin(feeds, eq(subscriptions.feedId, feeds.id))
        .where(and(eq(subscriptions.userId, userId), isNull(subscriptions.unsubscribedAt)))
        .orderBy(feeds.title);

      // Get all subscription IDs to fetch their tags
      const subscriptionIds = userSubscriptions.map(({ subscription }) => subscription.id);

      // Fetch all tags for all subscriptions in one query
      const subscriptionTagsData =
        subscriptionIds.length > 0
          ? await ctx.db
              .select({
                subscriptionId: subscriptionTags.subscriptionId,
                tagId: tags.id,
                tagName: tags.name,
                tagColor: tags.color,
              })
              .from(subscriptionTags)
              .innerJoin(tags, eq(subscriptionTags.tagId, tags.id))
              .where(inArray(subscriptionTags.subscriptionId, subscriptionIds))
          : [];

      // Create a map of subscriptionId -> tags[]
      const tagsMap = new Map<string, Array<{ id: string; name: string; color: string | null }>>();
      for (const row of subscriptionTagsData) {
        const existing = tagsMap.get(row.subscriptionId) ?? [];
        existing.push({
          id: row.tagId,
          name: row.tagName,
          color: row.tagColor,
        });
        tagsMap.set(row.subscriptionId, existing);
      }

      // Calculate unread counts for each subscription
      // An entry is unread if it exists in user_entries with read=false
      const items = await Promise.all(
        userSubscriptions.map(async ({ subscription, feed }) => {
          // Count unread entries visible to this user
          // Visibility is determined by existence of row in user_entries
          const unreadResult = await ctx.db
            .select({ count: sql<number>`count(*)::int` })
            .from(entries)
            .innerJoin(
              userEntries,
              and(eq(userEntries.entryId, entries.id), eq(userEntries.userId, userId))
            )
            .where(and(eq(entries.feedId, feed.id), eq(userEntries.read, false)));

          const unreadCount = unreadResult[0]?.count ?? 0;
          const subscriptionTagsList = tagsMap.get(subscription.id) ?? [];

          return {
            subscription: {
              id: subscription.id,
              feedId: subscription.feedId,
              customTitle: subscription.customTitle,
              subscribedAt: subscription.subscribedAt,
              unreadCount,
              tags: subscriptionTagsList,
            },
            feed: {
              id: feed.id,
              type: feed.type,
              url: feed.url,
              title: feed.title,
              description: feed.description,
              siteUrl: feed.siteUrl,
            },
          };
        })
      );

      return { items };
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
    .output(subscriptionWithFeedOutputSchema)
    .query(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;

      // Get the subscription with feed info
      const result = await ctx.db
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

      if (result.length === 0) {
        throw errors.subscriptionNotFound();
      }

      const { subscription, feed } = result[0];

      // Fetch tags for this subscription
      const subscriptionTagsData = await ctx.db
        .select({
          tagId: tags.id,
          tagName: tags.name,
          tagColor: tags.color,
        })
        .from(subscriptionTags)
        .innerJoin(tags, eq(subscriptionTags.tagId, tags.id))
        .where(eq(subscriptionTags.subscriptionId, subscription.id));

      const subscriptionTagsList = subscriptionTagsData.map((row) => ({
        id: row.tagId,
        name: row.tagName,
        color: row.tagColor,
      }));

      // Calculate unread count (visibility via user_entries)
      const unreadResult = await ctx.db
        .select({ count: sql<number>`count(*)::int` })
        .from(entries)
        .innerJoin(
          userEntries,
          and(eq(userEntries.entryId, entries.id), eq(userEntries.userId, userId))
        )
        .where(and(eq(entries.feedId, feed.id), eq(userEntries.read, false)));

      const unreadCount = unreadResult[0]?.count ?? 0;

      return {
        subscription: {
          id: subscription.id,
          feedId: subscription.feedId,
          customTitle: subscription.customTitle,
          subscribedAt: subscription.subscribedAt,
          unreadCount,
          tags: subscriptionTagsList,
        },
        feed: {
          id: feed.id,
          type: feed.type,
          url: feed.url,
          title: feed.title,
          description: feed.description,
          siteUrl: feed.siteUrl,
        },
      };
    }),

  /**
   * Update a subscription (custom title).
   *
   * Allows users to set a custom title for their subscription.
   * Pass null to remove the custom title and use the feed's default.
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
      })
    )
    .output(
      z.object({
        subscription: subscriptionOutputSchema,
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;

      // Verify the subscription exists and belongs to the user
      const existing = await ctx.db
        .select()
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

      const subscription = existing[0].subscriptions;
      const feed = existing[0].feeds;

      // Update the subscription
      const now = new Date();
      const updateData: { updatedAt: Date; customTitle?: string | null } = {
        updatedAt: now,
      };

      if (input.customTitle !== undefined) {
        updateData.customTitle = input.customTitle;
      }

      await ctx.db.update(subscriptions).set(updateData).where(eq(subscriptions.id, input.id));

      // Fetch tags for this subscription
      const subscriptionTagsData = await ctx.db
        .select({
          tagId: tags.id,
          tagName: tags.name,
          tagColor: tags.color,
        })
        .from(subscriptionTags)
        .innerJoin(tags, eq(subscriptionTags.tagId, tags.id))
        .where(eq(subscriptionTags.subscriptionId, subscription.id));

      const subscriptionTagsList = subscriptionTagsData.map((row) => ({
        id: row.tagId,
        name: row.tagName,
        color: row.tagColor,
      }));

      // Calculate unread count (visibility via user_entries)
      const unreadResult = await ctx.db
        .select({ count: sql<number>`count(*)::int` })
        .from(entries)
        .innerJoin(
          userEntries,
          and(eq(userEntries.entryId, entries.id), eq(userEntries.userId, userId))
        )
        .where(and(eq(entries.feedId, feed.id), eq(userEntries.read, false)));

      const unreadCount = unreadResult[0]?.count ?? 0;

      return {
        subscription: {
          id: subscription.id,
          feedId: subscription.feedId,
          customTitle:
            input.customTitle !== undefined ? input.customTitle : subscription.customTitle,
          subscribedAt: subscription.subscribedAt,
          unreadCount,
          tags: subscriptionTagsList,
        },
      };
    }),

  /**
   * Unsubscribe from a feed (soft delete).
   *
   * Sets unsubscribedAt timestamp instead of deleting the record.
   * This allows users to resubscribe later while preserving their read state.
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

      // Verify the subscription exists and belongs to the user
      const existing = await ctx.db
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

      if (existing.length === 0) {
        throw errors.subscriptionNotFound();
      }

      // Soft delete by setting unsubscribedAt
      const now = new Date();
      await ctx.db
        .update(subscriptions)
        .set({
          unsubscribedAt: now,
          updatedAt: now,
        })
        .where(eq(subscriptions.id, input.id));

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
        imported: z.number(),
        skipped: z.number(),
        failed: z.number(),
        results: z.array(
          z.object({
            url: z.string(),
            title: z.string().nullable(),
            status: z.enum(["imported", "skipped", "failed"]),
            error: z.string().optional(),
          })
        ),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;

      // Step 1: Parse the OPML content
      let opmlFeeds: OpmlFeed[];
      try {
        opmlFeeds = parseOpml(input.opml);
      } catch (error) {
        throw errors.validation(
          `Failed to parse OPML: ${error instanceof Error ? error.message : "Invalid OPML format"}`
        );
      }

      if (opmlFeeds.length === 0) {
        return {
          imported: 0,
          skipped: 0,
          failed: 0,
          results: [],
        };
      }

      // Step 2: Get existing subscriptions for the user
      const existingSubscriptions = await ctx.db
        .select({
          feedUrl: feeds.url,
        })
        .from(subscriptions)
        .innerJoin(feeds, eq(subscriptions.feedId, feeds.id))
        .where(and(eq(subscriptions.userId, userId), isNull(subscriptions.unsubscribedAt)));

      const existingUrls = new Set(existingSubscriptions.map((s) => s.feedUrl));

      // Step 3: Process each feed
      const results: Array<{
        url: string;
        title: string | null;
        status: "imported" | "skipped" | "failed";
        error?: string;
      }> = [];

      let imported = 0;
      let skipped = 0;
      let failed = 0;

      for (const opmlFeed of opmlFeeds) {
        const feedUrl = opmlFeed.xmlUrl;
        const feedTitle = opmlFeed.title ?? null;

        // Check if already subscribed
        if (existingUrls.has(feedUrl)) {
          results.push({
            url: feedUrl,
            title: feedTitle,
            status: "skipped",
            error: "Already subscribed",
          });
          skipped++;
          continue;
        }

        try {
          // Check if feed already exists in database
          const existingFeed = await ctx.db
            .select()
            .from(feeds)
            .where(eq(feeds.url, feedUrl))
            .limit(1);

          let feedId: string;

          if (existingFeed.length > 0) {
            // Feed exists - use it
            feedId = existingFeed[0].id;
          } else {
            // Create new feed record
            feedId = generateUuidv7();
            const now = new Date();

            await ctx.db.insert(feeds).values({
              id: feedId,
              type: "rss" as const, // Default to RSS, will be updated on first fetch
              url: feedUrl,
              title: feedTitle,
              siteUrl: opmlFeed.htmlUrl ?? null,
              nextFetchAt: now, // Schedule immediate fetch
              createdAt: now,
              updatedAt: now,
            });

            // Schedule initial fetch job for the new feed
            await createInitialFetchJob(feedId);
          }

          // Check for existing soft-deleted subscription
          const existingSub = await ctx.db
            .select()
            .from(subscriptions)
            .where(and(eq(subscriptions.userId, userId), eq(subscriptions.feedId, feedId)))
            .limit(1);

          const now = new Date();
          const subscriptionId = generateUuidv7();

          let actualSubscriptionId = subscriptionId;

          if (existingSub.length > 0 && existingSub[0].unsubscribedAt !== null) {
            // Reactivate soft-deleted subscription
            actualSubscriptionId = existingSub[0].id;
            await ctx.db
              .update(subscriptions)
              .set({
                unsubscribedAt: null,
                subscribedAt: now,
                updatedAt: now,
              })
              .where(eq(subscriptions.id, actualSubscriptionId));
          } else if (existingSub.length === 0) {
            // Create new subscription
            await ctx.db.insert(subscriptions).values({
              id: subscriptionId,
              userId,
              feedId,
              subscribedAt: now,
              createdAt: now,
              updatedAt: now,
            });
          }

          // Publish subscription_created event (fire and forget)
          publishSubscriptionCreated(userId, feedId, actualSubscriptionId).catch((err) => {
            logger.error("Failed to publish subscription_created event", { err, userId, feedId });
          });

          // Add to existing URLs set to prevent duplicates within this import
          existingUrls.add(feedUrl);

          results.push({
            url: feedUrl,
            title: feedTitle,
            status: "imported",
          });
          imported++;

          logger.info("OPML import: feed imported", { feedUrl, userId });
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : "Unknown error";
          results.push({
            url: feedUrl,
            title: feedTitle,
            status: "failed",
            error: errorMessage,
          });
          failed++;

          logger.warn("OPML import: feed import failed", { feedUrl, userId, error: errorMessage });
        }
      }

      logger.info("OPML import completed", {
        userId,
        imported,
        skipped,
        failed,
        total: opmlFeeds.length,
      });

      return {
        imported,
        skipped,
        failed,
        results,
      };
    }),

  /**
   * Export subscriptions as OPML.
   *
   * Generates an OPML XML file containing all active subscriptions
   * for the current user.
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

      // Get all active subscriptions with feed info
      const userSubscriptions = await ctx.db
        .select({
          subscription: subscriptions,
          feed: feeds,
        })
        .from(subscriptions)
        .innerJoin(feeds, eq(subscriptions.feedId, feeds.id))
        .where(and(eq(subscriptions.userId, userId), isNull(subscriptions.unsubscribedAt)))
        .orderBy(feeds.title);

      // Convert to OPML subscription format
      const opmlSubscriptions: OpmlSubscription[] = userSubscriptions
        .filter(({ feed }) => feed.url !== null)
        .map(({ subscription, feed }) => ({
          title: subscription.customTitle || feed.title || feed.url || "Untitled Feed",
          xmlUrl: feed.url!,
          htmlUrl: feed.siteUrl ?? undefined,
          // folder: undefined, // TODO: Add when tags are implemented
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

      // If tagIds is empty, just delete all existing tags
      if (input.tagIds.length === 0) {
        await ctx.db.delete(subscriptionTags).where(eq(subscriptionTags.subscriptionId, input.id));
        return {};
      }

      // Verify all tag IDs belong to the current user
      const userTags = await ctx.db
        .select({ id: tags.id })
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
      const now = new Date();
      await ctx.db.insert(subscriptionTags).values(
        input.tagIds.map((tagId) => ({
          subscriptionId: input.id,
          tagId,
          createdAt: now,
        }))
      );

      return {};
    }),
});

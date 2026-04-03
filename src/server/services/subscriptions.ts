/**
 * Subscriptions Service
 *
 * Business logic for subscription operations. Used by both tRPC routers, MCP server,
 * and background jobs.
 */

import { eq, and, sql, isNull, inArray } from "drizzle-orm";
import type { db as dbType } from "@/server/db";
import {
  entries,
  feeds,
  subscriptions,
  subscriptionFeeds,
  userEntries,
  tags,
  subscriptionTags,
  userFeeds,
} from "@/server/db/schema";
import { errors } from "@/server/trpc/errors";
import { generateUuidv7 } from "@/lib/uuidv7";
import { logger } from "@/lib/logger";
import { usageLimitsConfig } from "@/server/config/env";
import { fetchUrl, isHtmlContent } from "@/server/http/fetch";
import { parseFeedInWorker } from "@/server/worker-thread/pool";
import { discoverFeeds } from "@/server/feed/discovery";
import { deriveGuid } from "@/server/feed/entry-processor";
import { getDomainFromUrl } from "@/server/feed/types";
import { extractUserIdFromFeedUrl, fetchLessWrongUserById } from "@/server/feed/lesswrong";
import { ensureFeedJob } from "@/server/jobs/queue";
import { publishSubscriptionCreated } from "@/server/redis/pubsub";

// ============================================================================
// Types
// ============================================================================

export interface Tag {
  id: string;
  name: string;
  color: string | null;
}

export interface Subscription {
  id: string;
  type: "web" | "email" | "saved";
  url: string | null;
  title: string | null;
  originalTitle: string | null;
  description: string | null;
  siteUrl: string | null;
  subscribedAt: Date;
  unreadCount: number;
  tags: Tag[];
  fetchFullContent: boolean;
}

/**
 * Parameters for creating or reactivating a subscription.
 */
export interface CreateSubscriptionParams {
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
export interface CreateSubscriptionResult {
  /** Subscription ID */
  subscriptionId: string;
  /** When the subscription was created/reactivated */
  subscribedAt: Date;
  /** Whether this was a reactivation of a soft-deleted subscription */
  isReactivated: boolean;
  /** Number of unread entries populated */
  unreadCount: number;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Builds the base query for fetching subscriptions using the user_feeds view.
 * Includes unread counts and tags.
 */
export function buildSubscriptionBaseQuery(db: typeof dbType, userId: string) {
  // Subquery to get unread counts per feed
  const unreadCountsSubquery = db
    .select({
      feedId: entries.feedId,
      unreadCount: sql<number>`count(*)::int`.as("unread_count"),
    })
    .from(entries)
    .innerJoin(
      userEntries,
      and(eq(userEntries.entryId, entries.id), eq(userEntries.userId, userId))
    )
    .where(eq(userEntries.read, false))
    .groupBy(entries.feedId)
    .as("unread_counts");

  return db
    .select({
      // From user_feeds view - subscription fields
      id: userFeeds.id,
      subscribedAt: userFeeds.subscribedAt,
      feedId: userFeeds.feedId, // internal use only
      fetchFullContent: userFeeds.fetchFullContent,
      // From user_feeds view - feed fields (already merged)
      type: userFeeds.type,
      url: userFeeds.url,
      title: userFeeds.title, // already resolved (COALESCE of customTitle and original)
      originalTitle: userFeeds.originalTitle,
      description: userFeeds.description,
      siteUrl: userFeeds.siteUrl,
      // Unread count from subquery
      unreadCount: sql<number>`COALESCE(${unreadCountsSubquery.unreadCount}, 0)`,
      // Tags aggregated as JSON array
      tags: sql<Array<{ id: string; name: string; color: string | null }>>`
        COALESCE(
          json_agg(
            json_build_object('id', ${tags.id}, 'name', ${tags.name}, 'color', ${tags.color})
          ) FILTER (WHERE ${tags.id} IS NOT NULL),
          '[]'::json
        )
      `,
    })
    .from(userFeeds)
    .leftJoin(unreadCountsSubquery, eq(unreadCountsSubquery.feedId, userFeeds.feedId))
    .leftJoin(subscriptionTags, eq(subscriptionTags.subscriptionId, userFeeds.id))
    .leftJoin(tags, eq(tags.id, subscriptionTags.tagId))
    .groupBy(
      userFeeds.id,
      userFeeds.subscribedAt,
      userFeeds.feedId,
      userFeeds.fetchFullContent,
      userFeeds.type,
      userFeeds.url,
      userFeeds.title,
      userFeeds.originalTitle,
      userFeeds.description,
      userFeeds.siteUrl,
      unreadCountsSubquery.unreadCount
    );
}

/**
 * Type for a row returned by buildSubscriptionBaseQuery.
 */
export type SubscriptionQueryRow = Awaited<ReturnType<typeof buildSubscriptionBaseQuery>>[number];

/**
 * Transforms a subscription query row into the output format.
 */
export function formatSubscriptionRow(row: SubscriptionQueryRow): Subscription {
  return {
    id: row.id,
    type: row.type,
    url: row.url,
    title: row.title,
    originalTitle: row.originalTitle,
    description: row.description,
    siteUrl: row.siteUrl,
    subscribedAt: row.subscribedAt,
    unreadCount: row.unreadCount,
    tags: row.tags,
    fetchFullContent: row.fetchFullContent,
  };
}

// ============================================================================
// Subscription Creation
// ============================================================================

/**
 * Creates a new subscription or reactivates a soft-deleted one.
 *
 * This centralizes subscription creation logic used by subscribeByUrl,
 * OPML import, and other subscription creation paths.
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
  db: typeof dbType,
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
  db: typeof dbType,
  userId: string,
  feedRecord: typeof feeds.$inferSelect
): Promise<Subscription> {
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
  db: typeof dbType,
  userId: string,
  inputUrl: string
): Promise<Subscription> {
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
    parsedFeed = await parseFeedInWorker(feedContent);
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

/**
 * Subscribe a user to a feed by URL.
 *
 * This is the standard subscribe flow:
 * 1. If the feed URL is already known and fetched, uses the fast path (no network request)
 * 2. Otherwise, fetches the URL, discovers/parses the feed, creates the feed record
 * 3. Creates the subscription (or reactivates if previously unsubscribed)
 * 4. Publishes SSE events for real-time UI updates
 *
 * @param db - Database instance
 * @param params - User ID and feed URL
 * @returns The created subscription
 */
export async function subscribeByUrl(
  db: typeof dbType,
  params: { userId: string; url: string }
): Promise<Subscription> {
  const { userId, url: feedUrl } = params;

  // Check if this exact URL already exists as a feed that's been fetched
  // If so, we can skip the network request and use lastSeenAt to determine visibility
  const existingFeedByUrl = await db.select().from(feeds).where(eq(feeds.url, feedUrl)).limit(1);

  const canSkipFetch = existingFeedByUrl.length > 0 && existingFeedByUrl[0].lastFetchedAt !== null;

  if (canSkipFetch) {
    // Fast path: existing feed that's been fetched - no network request needed
    return await subscribeToExistingFeed(
      db,
      userId,
      existingFeedByUrl[0] as typeof feeds.$inferSelect
    );
  }

  // Slow path: need to fetch and potentially discover the feed
  return await subscribeToNewOrUnfetchedFeed(db, userId, feedUrl);
}

// ============================================================================
// Query Functions
// ============================================================================

export interface ListSubscriptionsParams {
  userId: string;
  query?: string; // Case-insensitive title search
  tagId?: string; // Filter by tag
  uncategorized?: boolean; // Only show subscriptions with no tags
  unreadOnly?: boolean; // Only show feeds with unread items
  cursor?: string; // Pagination cursor (base64-encoded JSON: {title, id})
  limit?: number; // Max results per page
}

export interface ListSubscriptionsResult {
  subscriptions: Subscription[];
  nextCursor?: string;
}

/**
 * Lists active subscriptions for a user with optional filtering and pagination.
 *
 * Supports:
 * - Case-insensitive title search
 * - Tag filtering
 * - Uncategorized filtering (subscriptions with no tags)
 * - Unread-only filtering
 * - Cursor-based pagination
 */
export async function listSubscriptions(
  db: typeof dbType,
  params: ListSubscriptionsParams
): Promise<ListSubscriptionsResult> {
  const { userId, query, tagId, uncategorized, unreadOnly, cursor, limit = 50 } = params;

  // Cap limit at 100
  const effectiveLimit = Math.min(limit, 100);

  // Apply filters
  const conditions = [eq(userFeeds.userId, userId)];

  // Title search (case-insensitive)
  if (query && query.length > 0) {
    const likePattern = `%${query}%`;
    conditions.push(sql`COALESCE(${userFeeds.title}, '') ILIKE ${likePattern}`);
  }

  // Tag filter
  if (tagId) {
    conditions.push(sql`EXISTS (
      SELECT 1 FROM ${subscriptionTags}
      WHERE ${subscriptionTags.subscriptionId} = ${userFeeds.id}
        AND ${subscriptionTags.tagId} = ${tagId}
    )`);
  }

  // Uncategorized filter (subscriptions with no tags)
  if (uncategorized) {
    conditions.push(sql`NOT EXISTS (
      SELECT 1 FROM ${subscriptionTags}
      WHERE ${subscriptionTags.subscriptionId} = ${userFeeds.id}
    )`);
  }

  // Unread filter (requires unread count > 0)
  if (unreadOnly) {
    // This will be checked after we get unread counts in the query
    // We'll filter in-memory since the unread count is computed
  }

  // Cursor pagination using (title, id) keyset for alphabetical ordering
  if (cursor) {
    try {
      const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf-8")) as {
        title: string | null;
        id: string;
      };
      // Keyset pagination: (title, id) > (cursor.title, cursor.id)
      // NULL titles sort first (COALESCE to empty string)
      conditions.push(sql`(
        COALESCE(${userFeeds.title}, '') > COALESCE(${decoded.title}::text, '')
        OR (
          COALESCE(${userFeeds.title}, '') = COALESCE(${decoded.title}::text, '')
          AND ${userFeeds.id} > ${decoded.id}
        )
      )`);
    } catch {
      // Invalid cursor - ignore and return from beginning
    }
  }

  // Build and execute query, sorted alphabetically by title then by id as tiebreaker
  const results = await buildSubscriptionBaseQuery(db, userId)
    .where(and(...conditions))
    .orderBy(sql`COALESCE(${userFeeds.title}, '') ASC`, userFeeds.id)
    .limit(effectiveLimit + 1);

  // Format results
  let subscriptions = results.map(formatSubscriptionRow);

  // Apply unread filter in-memory (since it depends on computed unread count)
  if (unreadOnly) {
    subscriptions = subscriptions.filter((sub) => sub.unreadCount > 0);
  }

  // Check if there are more results
  const hasMore = subscriptions.length > effectiveLimit;
  if (hasMore) {
    subscriptions = subscriptions.slice(0, effectiveLimit);
  }

  // Encode cursor as base64url JSON with title and id for keyset pagination
  let nextCursor: string | undefined;
  if (hasMore) {
    const lastSub = subscriptions[subscriptions.length - 1];
    nextCursor = Buffer.from(JSON.stringify({ title: lastSub.title, id: lastSub.id })).toString(
      "base64url"
    );
  }

  return {
    subscriptions,
    nextCursor,
  };
}

/**
 * Gets a single subscription by ID.
 */
export async function getSubscription(
  db: typeof dbType,
  userId: string,
  subscriptionId: string
): Promise<Subscription> {
  const results = await buildSubscriptionBaseQuery(db, userId)
    .where(and(eq(userFeeds.id, subscriptionId), eq(userFeeds.userId, userId)))
    .limit(1);

  if (results.length === 0) {
    throw errors.subscriptionNotFound();
  }

  return formatSubscriptionRow(results[0]);
}

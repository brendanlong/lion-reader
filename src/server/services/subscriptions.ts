/**
 * Subscriptions Service
 *
 * Business logic for subscription operations. Used by both tRPC routers and MCP server.
 */

import { eq, and, isNull, sql } from "drizzle-orm";
import type { db as dbType } from "@/server/db";
import {
  feeds,
  entries,
  subscriptions,
  subscriptionFeeds,
  userEntries,
  tags,
  subscriptionTags,
  userFeeds,
} from "@/server/db/schema";
import { generateUuidv7 } from "@/lib/uuidv7";
import { logger } from "@/lib/logger";
import { usageLimitsConfig } from "@/server/config/env";
import { ensureFeedJob } from "@/server/jobs/queue";
import { publishSubscriptionCreated } from "@/server/redis/pubsub";
import { errors } from "@/server/trpc/errors";

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
// Service Functions
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

// ============================================================================
// Subscription Creation
// ============================================================================

/**
 * Feed data for creating a subscription. For existing feeds, only `url` is required.
 * Other fields are used when creating new feed records.
 */
export interface CreateSubscriptionFeedInput {
  url: string;
  title?: string | null;
  description?: string | null;
  siteUrl?: string | null;
}

/**
 * Result of creating a subscription.
 */
export interface CreateSubscriptionResult {
  /** Subscription ID */
  subscriptionId: string;
  /** When the subscription was created */
  subscribedAt: Date;
  /** Number of unread entries populated */
  unreadCount: number;
  /** True if the subscription already existed and was active (idempotent return) */
  alreadyActive: boolean;
  /** Feed data (from existing or newly created feed) */
  feed: {
    id: string;
    type: "web" | "email" | "saved";
    url: string | null;
    title: string | null;
    description: string | null;
    siteUrl: string | null;
  };
}

/**
 * Creates a new subscription to a feed. Handles the full flow:
 * 1. Upserts the feed record (creates if new, uses existing otherwise)
 * 2. Ensures a background fetch job exists for the feed
 * 3. Checks subscription cap (with idempotent return if already subscribed)
 * 4. Upserts the subscription (creates new or reactivates soft-deleted)
 * 5. Populates initial user_entries so the user sees current feed content
 *
 * Idempotent: if the user already has an active subscription, returns it.
 */
export async function createSubscription(
  db: typeof dbType,
  userId: string,
  feed: CreateSubscriptionFeedInput
): Promise<CreateSubscriptionResult> {
  // 1. Upsert feed — insert if new, otherwise use existing
  const newFeedId = generateUuidv7();
  const now = new Date();
  await db
    .insert(feeds)
    .values({
      id: newFeedId,
      type: "web",
      url: feed.url,
      title: feed.title ?? null,
      description: feed.description ?? null,
      siteUrl: feed.siteUrl ?? null,
      nextFetchAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: feeds.url });

  const [feedRecord] = await db.select().from(feeds).where(eq(feeds.url, feed.url)).limit(1);
  if (!feedRecord) {
    throw new Error(`Feed disappeared after upsert: ${feed.url}`);
  }

  const feedId = feedRecord.id;
  const feedData = {
    id: feedId,
    type: feedRecord.type,
    url: feedRecord.url,
    title: feedRecord.title,
    description: feedRecord.description,
    siteUrl: feedRecord.siteUrl,
  };

  // 2. Ensure background fetch job exists
  await ensureFeedJob(feedId);

  // 3. Check subscription cap; if at cap, return existing or throw
  const maxSubs = usageLimitsConfig.maxSubscriptionsPerUser;
  const [{ activeCount }] = await db
    .select({ activeCount: sql<number>`count(*)::int` })
    .from(subscriptions)
    .where(and(eq(subscriptions.userId, userId), isNull(subscriptions.unsubscribedAt)));

  if (activeCount >= maxSubs) {
    // Over cap — check if we're already subscribed to this specific feed
    const [existingSub] = await db
      .select({
        id: subscriptions.id,
        subscribedAt: subscriptions.subscribedAt,
      })
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.userId, userId),
          eq(subscriptions.feedId, feedId),
          isNull(subscriptions.unsubscribedAt)
        )
      )
      .limit(1);

    if (existingSub) {
      const viewResults = await buildSubscriptionBaseQuery(db, userId)
        .where(eq(userFeeds.id, existingSub.id))
        .limit(1);

      return {
        subscriptionId: existingSub.id,
        subscribedAt: existingSub.subscribedAt,
        unreadCount: viewResults.length > 0 ? viewResults[0].unreadCount : 0,
        alreadyActive: true,
        feed: feedData,
      };
    }

    throw errors.maxSubscriptionsReached(maxSubs);
  }

  // 4. Upsert subscription — insert new or reactivate soft-deleted
  const newSubscriptionId = generateUuidv7();
  const subscribedAt = new Date();

  await db.execute(sql`
    INSERT INTO subscriptions (id, user_id, feed_id, subscribed_at, created_at, updated_at)
    VALUES (${newSubscriptionId}, ${userId}, ${feedId}, ${subscribedAt}, ${subscribedAt}, ${subscribedAt})
    ON CONFLICT (user_id, feed_id) DO UPDATE SET
      unsubscribed_at = NULL,
      subscribed_at = ${subscribedAt},
      updated_at = ${subscribedAt}
    WHERE subscriptions.unsubscribed_at IS NOT NULL
  `);

  // Get the actual subscription (may be newly inserted, reactivated, or unchanged)
  const [sub] = await db
    .select()
    .from(subscriptions)
    .where(and(eq(subscriptions.userId, userId), eq(subscriptions.feedId, feedId)))
    .limit(1);

  const alreadyActive = sub.subscribedAt.getTime() !== subscribedAt.getTime();

  if (alreadyActive) {
    // Subscription was already active — idempotent return with real unread count
    const viewResults = await buildSubscriptionBaseQuery(db, userId)
      .where(eq(userFeeds.id, sub.id))
      .limit(1);

    return {
      subscriptionId: sub.id,
      subscribedAt: sub.subscribedAt,
      unreadCount: viewResults.length > 0 ? viewResults[0].unreadCount : 0,
      alreadyActive: true,
      feed: feedData,
    };
  }

  // 5. Upsert subscription_feeds
  await db
    .insert(subscriptionFeeds)
    .values({ subscriptionId: sub.id, feedId, userId })
    .onConflictDoNothing();

  // 6. Populate user_entries using INSERT...SELECT and count unread
  let unreadCount = 0;
  if (feedRecord.lastEntriesUpdatedAt) {
    await db.execute(sql`
      INSERT INTO user_entries (user_id, entry_id)
      SELECT ${userId}, e.id
      FROM entries e
      WHERE e.feed_id = ${feedId}
        AND e.last_seen_at = ${feedRecord.lastEntriesUpdatedAt}
      ON CONFLICT DO NOTHING
    `);

    // Count unread entries (rowCount may be 0 for reactivations where entries already exist)
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(userEntries)
      .innerJoin(entries, eq(entries.id, userEntries.entryId))
      .where(
        and(eq(userEntries.userId, userId), eq(entries.feedId, feedId), eq(userEntries.read, false))
      );
    unreadCount = count;

    logger.debug("Populated initial user entries via lastSeenAt", {
      userId,
      feedId,
      entryCount: unreadCount,
    });
  }

  // 7. Publish SSE event for new/reactivated subscriptions
  if (!alreadyActive) {
    publishSubscriptionCreated(
      userId,
      feedId,
      sub.id,
      sub.subscribedAt,
      {
        id: sub.id,
        feedId,
        customTitle: null,
        subscribedAt: sub.subscribedAt.toISOString(),
        unreadCount,
        tags: [],
      },
      feedData
    ).catch((err) => {
      logger.error("Failed to publish subscription_created event", { err, userId, feedId });
    });
  }

  return {
    subscriptionId: sub.id,
    subscribedAt: sub.subscribedAt,
    unreadCount,
    alreadyActive,
    feed: feedData,
  };
}

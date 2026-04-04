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
 * Result of creating a subscription.
 */
export interface CreateSubscriptionResult {
  /** Subscription ID */
  subscriptionId: string;
  /** When the subscription was created */
  subscribedAt: Date;
  /** Number of unread entries populated */
  unreadCount: number;
}

/**
 * Creates a new subscription or reactivates a soft-deleted one. Idempotent:
 * if the user already has an active subscription to this feed, returns it.
 *
 * Uses the feed's lastEntriesUpdatedAt to populate initial user_entries so
 * the user sees current feed content immediately.
 */
export async function createSubscription(
  db: typeof dbType,
  userId: string,
  feedId: string
): Promise<CreateSubscriptionResult> {
  // Look up the feed's lastEntriesUpdatedAt for entry population
  const [feed] = await db
    .select({ lastEntriesUpdatedAt: feeds.lastEntriesUpdatedAt })
    .from(feeds)
    .where(eq(feeds.id, feedId))
    .limit(1);

  if (!feed) {
    throw errors.notFound("Feed not found");
  }

  // Check for existing subscription
  const [existingSub] = await db
    .select()
    .from(subscriptions)
    .where(and(eq(subscriptions.userId, userId), eq(subscriptions.feedId, feedId)))
    .limit(1);

  let subscriptionId: string;
  let subscribedAt: Date;

  if (existingSub && existingSub.unsubscribedAt === null) {
    // Already active - idempotent return
    // Get unread count from the view
    const viewResults = await buildSubscriptionBaseQuery(db, userId)
      .where(eq(userFeeds.id, existingSub.id))
      .limit(1);

    return {
      subscriptionId: existingSub.id,
      subscribedAt: existingSub.subscribedAt,
      unreadCount: viewResults.length > 0 ? viewResults[0].unreadCount : 0,
    };
  } else if (existingSub) {
    // Reactivate soft-deleted subscription (no count check needed - user already had this slot)
    subscriptionId = existingSub.id;
    subscribedAt = new Date();

    await db
      .update(subscriptions)
      .set({
        unsubscribedAt: null,
        subscribedAt,
        updatedAt: subscribedAt,
      })
      .where(eq(subscriptions.id, subscriptionId));
  } else {
    // Enforce subscription count limit
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

  // Populate user_entries for initial unread entries using lastEntriesUpdatedAt
  let unreadCount = 0;

  if (feed.lastEntriesUpdatedAt) {
    const matchingEntries = await db
      .select({ id: entries.id })
      .from(entries)
      .where(and(eq(entries.feedId, feedId), eq(entries.lastSeenAt, feed.lastEntriesUpdatedAt)));

    if (matchingEntries.length > 0) {
      await db
        .insert(userEntries)
        .values(matchingEntries.map((entry) => ({ userId, entryId: entry.id })))
        .onConflictDoNothing();
      unreadCount = matchingEntries.length;

      logger.debug("Populated initial user entries via lastSeenAt", {
        userId,
        feedId,
        entryCount: matchingEntries.length,
      });
    }
  }

  return {
    subscriptionId,
    subscribedAt,
    unreadCount,
  };
}

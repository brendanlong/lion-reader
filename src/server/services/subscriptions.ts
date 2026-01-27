/**
 * Subscriptions Service
 *
 * Business logic for subscription operations. Used by both tRPC routers and MCP server.
 */

import { eq, and, sql } from "drizzle-orm";
import type { db as dbType } from "@/server/db";
import { entries, userEntries, tags, subscriptionTags, userFeeds } from "@/server/db/schema";
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
function buildSubscriptionBaseQuery(db: typeof dbType, userId: string) {
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
type SubscriptionQueryRow = Awaited<ReturnType<typeof buildSubscriptionBaseQuery>>[number];

/**
 * Transforms a subscription query row into the output format.
 */
function formatSubscriptionRow(row: SubscriptionQueryRow): Subscription {
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
  unreadOnly?: boolean; // Only show feeds with unread items
  cursor?: string; // Pagination cursor (subscription ID)
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
 * - Unread-only filtering
 * - Cursor-based pagination
 */
export async function listSubscriptions(
  db: typeof dbType,
  params: ListSubscriptionsParams
): Promise<ListSubscriptionsResult> {
  const { userId, query, tagId, unreadOnly, cursor, limit = 50 } = params;

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

  // Unread filter (requires unread count > 0)
  if (unreadOnly) {
    // This will be checked after we get unread counts in the query
    // We'll filter in-memory since the unread count is computed
  }

  // Cursor pagination
  if (cursor) {
    conditions.push(sql`${userFeeds.id} > ${cursor}`);
  }

  // Build and execute query
  const results = await buildSubscriptionBaseQuery(db, userId)
    .where(and(...conditions))
    .orderBy(userFeeds.id)
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

  const nextCursor = hasMore ? subscriptions[subscriptions.length - 1].id : undefined;

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

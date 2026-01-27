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

/**
 * Lists all active subscriptions for a user.
 */
export async function listSubscriptions(
  db: typeof dbType,
  userId: string
): Promise<Subscription[]> {
  const results = await buildSubscriptionBaseQuery(db, userId)
    .where(eq(userFeeds.userId, userId))
    .orderBy(userFeeds.title);

  return results.map(formatSubscriptionRow);
}

/**
 * Searches subscriptions by title using case-insensitive substring matching.
 */
export async function searchSubscriptions(
  db: typeof dbType,
  userId: string,
  query: string
): Promise<Subscription[]> {
  // Use COALESCE to handle NULL titles, then ILIKE for case-insensitive substring matching
  // The % wildcards are added to search for the query as a substring
  const likePattern = `%${query}%`;

  const results = await buildSubscriptionBaseQuery(db, userId)
    .where(
      and(eq(userFeeds.userId, userId), sql`COALESCE(${userFeeds.title}, '') ILIKE ${likePattern}`)
    )
    .orderBy(userFeeds.title);

  return results.map(formatSubscriptionRow);
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

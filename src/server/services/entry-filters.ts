/**
 * Entry Filters Service
 *
 * Shared filter builder for entry queries. Used by listEntries, searchEntries,
 * countEntries, and markAllRead.
 */

import { eq, and, notInArray, sql } from "drizzle-orm";
import type { db as dbType } from "@/server/db";
import { subscriptionTags, tags, userFeeds } from "@/server/db/schema";

// ============================================================================
// Types
// ============================================================================

export interface EntryFilterParams {
  subscriptionId?: string;
  tagId?: string;
  uncategorized?: boolean;
}

/**
 * Type for feed IDs condition that can be used with inArray.
 * This is either a string array (for subscription filters) or a Drizzle subquery
 * (for tag or uncategorized filters).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FeedIdsCondition = string[] | any;

/**
 * Result of building entry feed filters.
 *
 * @property feedIdsCondition - Either an array of feed IDs, a subquery that returns feed IDs,
 *                              or null if no feed filter is needed
 * @property isEmpty - True if the filter conditions result in no possible matches
 *                    (e.g., invalid subscription ID, non-existent tag)
 */
export interface EntryFilterResult {
  feedIdsCondition: FeedIdsCondition | null;
  isEmpty: boolean;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Gets feed IDs for a subscription from the user_feeds view.
 */
async function getSubscriptionFeedIds(
  db: typeof dbType,
  subscriptionId: string,
  userId: string
): Promise<string[] | null> {
  const result = await db
    .select({ feedIds: userFeeds.feedIds })
    .from(userFeeds)
    .where(and(eq(userFeeds.id, subscriptionId), eq(userFeeds.userId, userId)))
    .limit(1);

  return result.length > 0 ? result[0].feedIds : null;
}

/**
 * Builds a subquery for feed IDs associated with a tag.
 * The join with tags table ensures the tag belongs to the user, eliminating
 * the need for a separate tag ownership validation query.
 */
function buildTaggedFeedIdsSubquery(db: typeof dbType, tagId: string, userId: string) {
  return db
    .select({ feedId: sql<string>`unnest(${userFeeds.feedIds})`.as("feed_id") })
    .from(subscriptionTags)
    .innerJoin(userFeeds, eq(subscriptionTags.subscriptionId, userFeeds.id))
    .innerJoin(tags, and(eq(subscriptionTags.tagId, tags.id), eq(tags.userId, userId)))
    .where(eq(subscriptionTags.tagId, tagId));
}

/**
 * Builds a subquery for feed IDs from uncategorized subscriptions.
 */
function buildUncategorizedFeedIdsSubquery(db: typeof dbType, userId: string) {
  const taggedSubscriptionIds = db
    .select({ subscriptionId: subscriptionTags.subscriptionId })
    .from(subscriptionTags);

  return db
    .select({ feedId: sql<string>`unnest(${userFeeds.feedIds})`.as("feed_id") })
    .from(userFeeds)
    .where(and(eq(userFeeds.userId, userId), notInArray(userFeeds.id, taggedSubscriptionIds)));
}

// ============================================================================
// Main Filter Builder
// ============================================================================

/**
 * Builds feed filter conditions for entry queries.
 *
 * This function handles the three main feed-based filters:
 * 1. subscriptionId - Filter to entries from a specific subscription's feeds
 * 2. tagId - Filter to entries from feeds belonging to tagged subscriptions
 * 3. uncategorized - Filter to entries from untagged subscriptions
 *
 * @param db - Database instance
 * @param params - Filter parameters
 * @param userId - User ID for ownership validation
 * @returns Filter result with feedIdsCondition and isEmpty flag
 */
export async function buildEntryFeedFilter(
  db: typeof dbType,
  params: EntryFilterParams,
  userId: string
): Promise<EntryFilterResult> {
  // Filter by subscriptionId - returns array of feed IDs or null for early exit
  if (params.subscriptionId) {
    const feedIds = await getSubscriptionFeedIds(db, params.subscriptionId, userId);
    if (feedIds === null) {
      return { feedIdsCondition: null, isEmpty: true };
    }
    return { feedIdsCondition: feedIds, isEmpty: false };
  }

  // Filter by tagId - uses join to validate tag ownership, returns subquery
  // The subquery will return no rows if the tag doesn't exist or belongs to another user
  if (params.tagId) {
    const taggedFeedIds = buildTaggedFeedIdsSubquery(db, params.tagId, userId);
    return { feedIdsCondition: taggedFeedIds, isEmpty: false };
  }

  // Filter by uncategorized - returns subquery
  if (params.uncategorized) {
    const uncategorizedFeedIds = buildUncategorizedFeedIdsSubquery(db, userId);
    return { feedIdsCondition: uncategorizedFeedIds, isEmpty: false };
  }

  // No feed filter needed
  return { feedIdsCondition: null, isEmpty: false };
}

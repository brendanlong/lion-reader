/**
 * Entry Filters Service
 *
 * Shared filter builder for entry queries. Used by listEntries, searchEntries,
 * countEntries, and markAllRead.
 */

import { eq, and, isNull, notInArray, type SQL } from "drizzle-orm";
import type { db as dbType } from "@/server/db";
import {
  subscriptionFeeds,
  subscriptionTags,
  tags,
  userFeeds,
  visibleEntries,
} from "@/server/db/schema";

// ============================================================================
// Types
// ============================================================================

export interface EntryFilterParams {
  subscriptionId?: string;
  tagId?: string;
  uncategorized?: boolean;
}

export interface EntryConditionParams {
  unreadOnly?: boolean;
  readOnly?: boolean;
  starredOnly?: boolean;
  unstarredOnly?: boolean;
  type?: "web" | "email" | "saved";
  excludeTypes?: Array<"web" | "email" | "saved">;
  showSpam: boolean;
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
 * Gets feed IDs for a subscription from the subscription_feeds junction table.
 */
async function getSubscriptionFeedIds(
  db: typeof dbType,
  subscriptionId: string,
  userId: string
): Promise<string[] | null> {
  // Verify subscription exists and belongs to user
  const subExists = await db
    .select({ id: userFeeds.id })
    .from(userFeeds)
    .where(and(eq(userFeeds.id, subscriptionId), eq(userFeeds.userId, userId)))
    .limit(1);

  if (subExists.length === 0) {
    return null;
  }

  const result = await db
    .select({ feedId: subscriptionFeeds.feedId })
    .from(subscriptionFeeds)
    .where(eq(subscriptionFeeds.subscriptionId, subscriptionId));

  return result.map((r) => r.feedId);
}

/**
 * Builds a subquery for feed IDs associated with a tag.
 * The join with tags table ensures the tag belongs to the user, eliminating
 * the need for a separate tag ownership validation query.
 */
function buildTaggedFeedIdsSubquery(db: typeof dbType, tagId: string, userId: string) {
  return db
    .select({ feedId: subscriptionFeeds.feedId })
    .from(subscriptionTags)
    .innerJoin(
      subscriptionFeeds,
      eq(subscriptionTags.subscriptionId, subscriptionFeeds.subscriptionId)
    )
    .innerJoin(tags, and(eq(subscriptionTags.tagId, tags.id), eq(tags.userId, userId)))
    .where(eq(subscriptionTags.tagId, tagId));
}

/**
 * Builds a subquery for feed IDs from uncategorized subscriptions.
 * Uses a LEFT JOIN anti-join pattern: subscriptions with no matching
 * subscription_tags row are "uncategorized".
 */
function buildUncategorizedFeedIdsSubquery(db: typeof dbType, userId: string) {
  return db
    .select({ feedId: subscriptionFeeds.feedId })
    .from(userFeeds)
    .innerJoin(subscriptionFeeds, eq(subscriptionFeeds.subscriptionId, userFeeds.id))
    .leftJoin(subscriptionTags, eq(subscriptionTags.subscriptionId, userFeeds.id))
    .where(and(eq(userFeeds.userId, userId), isNull(subscriptionTags.subscriptionId)));
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

// ============================================================================
// Entry Condition Builder
// ============================================================================

/**
 * Builds shared filter conditions for entry queries (unreadOnly, starredOnly,
 * type, excludeTypes, showSpam). Used by listEntries, searchEntries, and
 * countEntries to avoid duplicating the same filter logic.
 */
export function buildEntryFilterConditions(params: EntryConditionParams): SQL[] {
  const conditions: SQL[] = [];

  if (params.unreadOnly) {
    conditions.push(eq(visibleEntries.read, false));
  } else if (params.readOnly) {
    conditions.push(eq(visibleEntries.read, true));
  }

  if (params.starredOnly) {
    conditions.push(eq(visibleEntries.starred, true));
  } else if (params.unstarredOnly) {
    conditions.push(eq(visibleEntries.starred, false));
  }

  if (params.type) {
    conditions.push(eq(visibleEntries.type, params.type));
  }

  if (params.excludeTypes && params.excludeTypes.length > 0) {
    conditions.push(notInArray(visibleEntries.type, params.excludeTypes));
  }

  if (!params.showSpam) {
    conditions.push(eq(visibleEntries.isSpam, false));
  }

  return conditions;
}

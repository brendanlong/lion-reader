/**
 * Entry Counts Service
 *
 * Provides optimized queries for fetching unread counts related to an entry.
 * Used by mutations and SSE events to return absolute counts for cache updates.
 *
 * Optimizations:
 * - Saved articles skip subscription/tag queries entirely
 * - Web/email entries only fetch counts for their specific subscription's tags
 * - Uses COUNT(*) FILTER for efficient conditional aggregation
 */

import { eq, and, sql, inArray } from "drizzle-orm";
import type { db as dbType } from "@/server/db";
import { visibleEntries, subscriptionTags, userFeeds } from "@/server/db/schema";

// ============================================================================
// Types
// ============================================================================

/**
 * Global entry counts (all articles, starred).
 */
export interface GlobalCounts {
  all: { total: number; unread: number };
  starred: { total: number; unread: number };
}

/**
 * Saved article counts.
 */
export interface SavedCounts {
  saved: { total: number; unread: number };
}

/**
 * Tag unread count.
 */
export interface TagCount {
  id: string;
  unread: number;
}

/**
 * Subscription-related counts (subscription itself + its tags or uncategorized).
 */
export interface SubscriptionCounts {
  subscription: { id: string; unread: number };
  tags: TagCount[];
  uncategorized: { unread: number } | null;
}

/**
 * Complete unread counts for an entry, containing only the lists the entry belongs to.
 */
export interface UnreadCounts {
  // Always present
  all: { total: number; unread: number };
  starred: { total: number; unread: number };

  // Only for saved articles
  saved?: { total: number; unread: number };

  // Only for web/email entries (have subscriptions)
  subscription?: { id: string; unread: number };
  tags?: TagCount[];
  uncategorized?: { unread: number };
}

// ============================================================================
// Service Functions
// ============================================================================

/**
 * Fetches unread counts for all lists an entry belongs to.
 *
 * Optimized based on entry type:
 * - Saved articles: 1 query (global + saved counts)
 * - Web/email entries: 2 queries (global + subscription/tags counts)
 *
 * @param db - Database instance
 * @param userId - User ID
 * @param entryId - Entry ID to get counts for
 * @returns Unread counts for all affected lists
 */
export async function getEntryRelatedCounts(
  db: typeof dbType,
  userId: string,
  entryId: string
): Promise<UnreadCounts> {
  // Query 1: Get entry context + global counts + saved counts + subscription count in one query
  const result = await db
    .select({
      subscriptionId: visibleEntries.subscriptionId,
      type: visibleEntries.type,
      // Global counts
      allTotal: sql<number>`count(*)::int`,
      allUnread: sql<number>`count(*) FILTER (WHERE NOT ${visibleEntries.read})::int`,
      // Starred counts
      starredTotal: sql<number>`count(*) FILTER (WHERE ${visibleEntries.starred})::int`,
      starredUnread: sql<number>`count(*) FILTER (WHERE ${visibleEntries.starred} AND NOT ${visibleEntries.read})::int`,
      // Saved counts (computed for all, but only used if type = 'saved')
      savedTotal: sql<number>`count(*) FILTER (WHERE ${visibleEntries.type} = 'saved')::int`,
      savedUnread: sql<number>`count(*) FILTER (WHERE ${visibleEntries.type} = 'saved' AND NOT ${visibleEntries.read})::int`,
      // Subscription count (computed for all, but only used if entry has subscription)
      subscriptionUnread: sql<number>`count(*) FILTER (WHERE ${visibleEntries.subscriptionId} = (
        SELECT subscription_id FROM visible_entries WHERE user_id = ${userId} AND id = ${entryId}
      ) AND NOT ${visibleEntries.read})::int`,
    })
    .from(visibleEntries)
    .where(eq(visibleEntries.userId, userId));

  if (result.length === 0) {
    // Entry not found or user doesn't have access
    return {
      all: { total: 0, unread: 0 },
      starred: { total: 0, unread: 0 },
    };
  }

  // Get entry info from a separate query to know its context
  const entryInfo = await db
    .select({
      subscriptionId: visibleEntries.subscriptionId,
      type: visibleEntries.type,
    })
    .from(visibleEntries)
    .where(and(eq(visibleEntries.userId, userId), eq(visibleEntries.id, entryId)))
    .limit(1);

  if (entryInfo.length === 0) {
    return {
      all: { total: 0, unread: 0 },
      starred: { total: 0, unread: 0 },
    };
  }

  const { subscriptionId, type } = entryInfo[0];
  const counts = result[0];

  const baseCounts: UnreadCounts = {
    all: { total: counts.allTotal, unread: counts.allUnread },
    starred: { total: counts.starredTotal, unread: counts.starredUnread },
  };

  // For saved articles, include saved counts and return
  if (type === "saved") {
    return {
      ...baseCounts,
      saved: { total: counts.savedTotal, unread: counts.savedUnread },
    };
  }

  // For web/email entries without subscription (shouldn't happen, but handle gracefully)
  if (!subscriptionId) {
    return baseCounts;
  }

  // Query 2: Get tag counts for this subscription's tags only
  const tagResult = await getSubscriptionTagCounts(db, userId, subscriptionId);

  return {
    ...baseCounts,
    subscription: { id: subscriptionId, unread: counts.subscriptionUnread },
    tags: tagResult.tags,
    uncategorized: tagResult.uncategorized ?? undefined,
  };
}

/**
 * Fetches tag unread counts for a specific subscription's tags.
 * If the subscription has no tags, returns uncategorized count instead.
 *
 * @param db - Database instance
 * @param userId - User ID
 * @param subscriptionId - Subscription ID
 * @returns Tag counts or uncategorized count
 */
async function getSubscriptionTagCounts(
  db: typeof dbType,
  userId: string,
  subscriptionId: string
): Promise<{ tags: TagCount[]; uncategorized: { unread: number } | null }> {
  // First check if this subscription has any tags
  const subTags = await db
    .select({ tagId: subscriptionTags.tagId })
    .from(subscriptionTags)
    .where(eq(subscriptionTags.subscriptionId, subscriptionId));

  if (subTags.length === 0) {
    // Subscription has no tags - get uncategorized count
    const uncategorizedResult = await db
      .select({
        unread: sql<number>`count(*) FILTER (WHERE NOT ${visibleEntries.read})::int`,
      })
      .from(visibleEntries)
      .innerJoin(userFeeds, eq(userFeeds.id, visibleEntries.subscriptionId))
      .where(
        and(
          eq(visibleEntries.userId, userId),
          sql`NOT EXISTS (
            SELECT 1 FROM subscription_tags st
            WHERE st.subscription_id = ${userFeeds.id}
          )`
        )
      );

    return {
      tags: [],
      uncategorized: { unread: uncategorizedResult[0]?.unread ?? 0 },
    };
  }

  // Subscription has tags - get counts for each tag
  const tagIds = subTags.map((t) => t.tagId);

  // Get unread counts for entries in subscriptions with these tags
  const tagCounts = await db
    .select({
      tagId: subscriptionTags.tagId,
      unread: sql<number>`count(*) FILTER (WHERE NOT ${visibleEntries.read})::int`,
    })
    .from(subscriptionTags)
    .innerJoin(visibleEntries, eq(visibleEntries.subscriptionId, subscriptionTags.subscriptionId))
    .where(and(eq(visibleEntries.userId, userId), inArray(subscriptionTags.tagId, tagIds)))
    .groupBy(subscriptionTags.tagId);

  return {
    tags: tagCounts.map((t) => ({ id: t.tagId, unread: t.unread })),
    uncategorized: null,
  };
}

/**
 * Counts for multiple entries, with subscription and tag counts aggregated.
 * Used by markRead to return counts for all affected lists.
 */
export interface BulkUnreadCounts {
  // Always present
  all: { total: number; unread: number };
  starred: { total: number; unread: number };
  saved: { total: number; unread: number };

  // Per-subscription counts (only subscriptions that were affected)
  subscriptions: Array<{ id: string; unread: number }>;

  // Per-tag counts (only tags that were affected)
  tags: Array<{ id: string; unread: number }>;

  // Uncategorized count (if any affected subscription has no tags)
  uncategorized?: { unread: number };
}

/**
 * Fetches unread counts for multiple entries' lists.
 * Collects unique subscriptions and tags from the entries and returns counts for each.
 *
 * @param db - Database instance
 * @param userId - User ID
 * @param entries - Entries with their context (subscriptionId, type)
 * @returns Aggregated unread counts for all affected lists
 */
export async function getBulkEntryRelatedCounts(
  db: typeof dbType,
  userId: string,
  entries: Array<{ subscriptionId: string | null; type: "web" | "email" | "saved" }>
): Promise<BulkUnreadCounts> {
  // Collect unique subscription IDs (excluding null for saved articles)
  const subscriptionIds = [
    ...new Set(entries.map((e) => e.subscriptionId).filter((id) => id !== null)),
  ] as string[];

  // Query 1: Get global counts + saved counts + per-subscription counts in one query
  const globalResult = await db
    .select({
      allTotal: sql<number>`count(*)::int`,
      allUnread: sql<number>`count(*) FILTER (WHERE NOT ${visibleEntries.read})::int`,
      starredTotal: sql<number>`count(*) FILTER (WHERE ${visibleEntries.starred})::int`,
      starredUnread: sql<number>`count(*) FILTER (WHERE ${visibleEntries.starred} AND NOT ${visibleEntries.read})::int`,
      savedTotal: sql<number>`count(*) FILTER (WHERE ${visibleEntries.type} = 'saved')::int`,
      savedUnread: sql<number>`count(*) FILTER (WHERE ${visibleEntries.type} = 'saved' AND NOT ${visibleEntries.read})::int`,
    })
    .from(visibleEntries)
    .where(eq(visibleEntries.userId, userId));

  const globalCounts = globalResult[0] ?? {
    allTotal: 0,
    allUnread: 0,
    starredTotal: 0,
    starredUnread: 0,
    savedTotal: 0,
    savedUnread: 0,
  };

  const baseCounts: BulkUnreadCounts = {
    all: { total: globalCounts.allTotal, unread: globalCounts.allUnread },
    starred: { total: globalCounts.starredTotal, unread: globalCounts.starredUnread },
    saved: { total: globalCounts.savedTotal, unread: globalCounts.savedUnread },
    subscriptions: [],
    tags: [],
  };

  // If no subscriptions affected (all saved entries), return base counts
  if (subscriptionIds.length === 0) {
    return baseCounts;
  }

  // Query 2: Get per-subscription counts
  const subscriptionCounts = await db
    .select({
      subscriptionId: visibleEntries.subscriptionId,
      unread: sql<number>`count(*) FILTER (WHERE NOT ${visibleEntries.read})::int`,
    })
    .from(visibleEntries)
    .where(
      and(
        eq(visibleEntries.userId, userId),
        inArray(visibleEntries.subscriptionId, subscriptionIds)
      )
    )
    .groupBy(visibleEntries.subscriptionId);

  baseCounts.subscriptions = subscriptionCounts
    .filter((s) => s.subscriptionId !== null)
    .map((s) => ({ id: s.subscriptionId!, unread: s.unread }));

  // Query 3: Get tags for affected subscriptions
  const subTags = await db
    .select({
      subscriptionId: subscriptionTags.subscriptionId,
      tagId: subscriptionTags.tagId,
    })
    .from(subscriptionTags)
    .where(inArray(subscriptionTags.subscriptionId, subscriptionIds));

  const tagIds = [...new Set(subTags.map((t) => t.tagId))];
  const subscriptionsWithTags = new Set(subTags.map((t) => t.subscriptionId));
  const hasUncategorized = subscriptionIds.some((id) => !subscriptionsWithTags.has(id));

  // Query 4: Get per-tag counts (if any tags)
  if (tagIds.length > 0) {
    const tagCounts = await db
      .select({
        tagId: subscriptionTags.tagId,
        unread: sql<number>`count(*) FILTER (WHERE NOT ${visibleEntries.read})::int`,
      })
      .from(subscriptionTags)
      .innerJoin(visibleEntries, eq(visibleEntries.subscriptionId, subscriptionTags.subscriptionId))
      .where(and(eq(visibleEntries.userId, userId), inArray(subscriptionTags.tagId, tagIds)))
      .groupBy(subscriptionTags.tagId);

    baseCounts.tags = tagCounts.map((t) => ({ id: t.tagId, unread: t.unread }));
  }

  // Query 5: Get uncategorized count (if any subscription has no tags)
  if (hasUncategorized) {
    const uncategorizedResult = await db
      .select({
        unread: sql<number>`count(*) FILTER (WHERE NOT ${visibleEntries.read})::int`,
      })
      .from(visibleEntries)
      .innerJoin(userFeeds, eq(userFeeds.id, visibleEntries.subscriptionId))
      .where(
        and(
          eq(visibleEntries.userId, userId),
          sql`NOT EXISTS (
            SELECT 1 FROM subscription_tags st
            WHERE st.subscription_id = ${userFeeds.id}
          )`
        )
      );

    baseCounts.uncategorized = { unread: uncategorizedResult[0]?.unread ?? 0 };
  }

  return baseCounts;
}

/**
 * Fetches unread counts for a new entry (doesn't exist yet in visible_entries).
 * Used when creating saved articles or when SSE needs counts for a new entry.
 *
 * @param db - Database instance
 * @param userId - User ID
 * @param entryType - Type of entry being created
 * @param subscriptionId - Subscription ID (null for saved articles)
 * @returns Unread counts for all affected lists
 */
export async function getNewEntryRelatedCounts(
  db: typeof dbType,
  userId: string,
  entryType: "web" | "email" | "saved",
  subscriptionId: string | null
): Promise<UnreadCounts> {
  // Query global + saved + subscription counts in one query
  const result = await db
    .select({
      // Global counts
      allTotal: sql<number>`count(*)::int`,
      allUnread: sql<number>`count(*) FILTER (WHERE NOT ${visibleEntries.read})::int`,
      // Starred counts
      starredTotal: sql<number>`count(*) FILTER (WHERE ${visibleEntries.starred})::int`,
      starredUnread: sql<number>`count(*) FILTER (WHERE ${visibleEntries.starred} AND NOT ${visibleEntries.read})::int`,
      // Saved counts
      savedTotal: sql<number>`count(*) FILTER (WHERE ${visibleEntries.type} = 'saved')::int`,
      savedUnread: sql<number>`count(*) FILTER (WHERE ${visibleEntries.type} = 'saved' AND NOT ${visibleEntries.read})::int`,
      // Subscription count (only computed if subscriptionId provided)
      subscriptionUnread:
        subscriptionId !== null
          ? sql<number>`count(*) FILTER (WHERE ${visibleEntries.subscriptionId} = ${subscriptionId} AND NOT ${visibleEntries.read})::int`
          : sql<number>`0`,
    })
    .from(visibleEntries)
    .where(eq(visibleEntries.userId, userId));

  const counts = result[0] ?? {
    allTotal: 0,
    allUnread: 0,
    starredTotal: 0,
    starredUnread: 0,
    savedTotal: 0,
    savedUnread: 0,
    subscriptionUnread: 0,
  };

  const baseCounts: UnreadCounts = {
    all: { total: counts.allTotal, unread: counts.allUnread },
    starred: { total: counts.starredTotal, unread: counts.starredUnread },
  };

  // For saved articles, include saved counts
  if (entryType === "saved") {
    return {
      ...baseCounts,
      saved: { total: counts.savedTotal, unread: counts.savedUnread },
    };
  }

  // For web/email without subscription (shouldn't happen)
  if (!subscriptionId) {
    return baseCounts;
  }

  // Get tag counts for web/email entries
  const tagResult = await getSubscriptionTagCounts(db, userId, subscriptionId);

  return {
    ...baseCounts,
    subscription: { id: subscriptionId, unread: counts.subscriptionUnread },
    tags: tagResult.tags,
    uncategorized: tagResult.uncategorized ?? undefined,
  };
}

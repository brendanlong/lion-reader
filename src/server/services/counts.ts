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
import type { db as dbType, DbOrTx } from "@/server/db";
import { visibleEntries, subscriptionTags, userFeeds } from "@/server/db/schema";

// ============================================================================
// Types
// ============================================================================

/**
 * Global entry counts (all articles, starred).
 */
export interface GlobalCounts {
  all: { unread: number };
  starred: { unread: number };
}

/**
 * Saved article counts.
 */
export interface SavedCounts {
  saved: { unread: number };
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
  all: { unread: number };
  starred: { unread: number };

  // Only for saved articles
  saved?: { unread: number };

  // Only for web/email entries (have subscriptions)
  subscription?: { id: string; unread: number };
  tags?: TagCount[];
  uncategorized?: { unread: number };
}

/**
 * Absolute counts shape sent with new_entry events. Mirrors the bulk
 * `unreadCountsSchema` the client applies via setBulkCounts (subscriptions as
 * an array), but with `saved` optional since web/email entries don't compute
 * it. The single-entry `UnreadCounts` returned by getNewEntryRelatedCounts is
 * mapped into this shape by `toBulkUnreadCounts`.
 */
export interface NewEntryUnreadCounts {
  all: { unread: number };
  starred: { unread: number };
  saved?: { unread: number };
  subscriptions: Array<{ id: string; unread: number }>;
  tags: TagCount[];
  uncategorized?: { unread: number };
}

/**
 * Maps single-entry `UnreadCounts` into the array-shaped `NewEntryUnreadCounts`
 * carried by new_entry events (and consumed by the client's setBulkCounts).
 */
export function toBulkUnreadCounts(counts: UnreadCounts): NewEntryUnreadCounts {
  return {
    all: counts.all,
    starred: counts.starred,
    ...(counts.saved ? { saved: counts.saved } : {}),
    subscriptions: counts.subscription ? [counts.subscription] : [],
    tags: counts.tags ?? [],
    ...(counts.uncategorized ? { uncategorized: counts.uncategorized } : {}),
  };
}

// ============================================================================
// Service Functions
// ============================================================================

/**
 * Global unread counts (all + starred + saved) for a user.
 *
 * `count(DISTINCT id)` — not `count(*)` — because `visible_entries` emits one
 * row per matching `subscription_feeds` row, so an entry reachable through
 * overlapping subscriptions (redirect/merge history) appears multiple times and
 * a plain `count(*)` over-counts. DISTINCT dedupes by entry id, matching the
 * per-tag/uncategorized counts below. Keeping the visibility rule in the view
 * (rather than re-deriving it here) means it stays defined in exactly one place.
 *
 * `read = false` is in WHERE (not a FILTER predicate) so the partial
 * `idx_user_entries_unread` index can drive the scan; every aggregate is then a
 * subset of unread. An `EXPLAIN ANALYZE` on a heavy user (50k entries, 45k
 * unread) confirmed the view's set-based hash joins run once in ~30ms — pushing
 * the visibility check onto the base tables with a correlated `EXISTS` was ~25x
 * slower (per-row subplan), so the view scan is the right shape here.
 */
async function getGlobalUnreadCounts(
  db: DbOrTx,
  userId: string
): Promise<{ allUnread: number; starredUnread: number; savedUnread: number }> {
  const result = await db
    .select({
      allUnread: sql<number>`count(DISTINCT ${visibleEntries.id})::int`,
      starredUnread: sql<number>`count(DISTINCT ${visibleEntries.id}) FILTER (WHERE ${visibleEntries.starred})::int`,
      savedUnread: sql<number>`count(DISTINCT ${visibleEntries.id}) FILTER (WHERE ${visibleEntries.type} = 'saved')::int`,
    })
    .from(visibleEntries)
    .where(and(eq(visibleEntries.userId, userId), eq(visibleEntries.read, false)));
  return result[0] ?? { allUnread: 0, starredUnread: 0, savedUnread: 0 };
}

/**
 * Fetches unread counts for all lists an entry belongs to.
 *
 * Optimized based on entry type:
 * - Saved articles: 1 query (global + saved + entry info in single scan)
 * - Web/email entries: 2 queries (global scan + tag counts)
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
  // The entry's context (subscription, type) is looked up separately from the
  // unread counts. The counts query pushes read=false into WHERE so the partial
  // idx_user_entries_unread index drives the scan; the target entry is usually
  // already read by the time we recompute counts, so it must not be required to
  // appear in the unread scan (which would happen if we co-located the lookup).
  const [entryInfoRows, counts] = await Promise.all([
    db
      .select({ subscriptionId: visibleEntries.subscriptionId, type: visibleEntries.type })
      .from(visibleEntries)
      .where(and(eq(visibleEntries.userId, userId), eq(visibleEntries.id, entryId)))
      .limit(1),
    getGlobalUnreadCounts(db, userId),
  ]);

  const entryInfo = entryInfoRows[0];

  const baseCounts: UnreadCounts = {
    all: { unread: counts.allUnread },
    starred: { unread: counts.starredUnread },
  };

  // Entry not found in this user's visible entries: still return the real
  // global counts (just computed above) — fabricated zeros would wipe the
  // user's badges if a caller patched them into the cache.
  if (!entryInfo) {
    return baseCounts;
  }

  const subscriptionId = entryInfo.subscriptionId;
  const type = entryInfo.type;

  // For saved articles, include saved counts and return (no subscription/tag queries needed)
  if (type === "saved") {
    return {
      ...baseCounts,
      saved: { unread: counts.savedUnread },
    };
  }

  // For web/email entries without subscription (shouldn't happen, but handle gracefully)
  if (!subscriptionId) {
    return baseCounts;
  }

  // Query 2: Get subscription unread count + tag counts in parallel
  const [subscriptionUnreadResult, tagResult] = await Promise.all([
    db
      .select({
        unread: sql<number>`count(*)::int`,
      })
      .from(visibleEntries)
      .where(
        and(
          eq(visibleEntries.userId, userId),
          eq(visibleEntries.read, false),
          eq(visibleEntries.subscriptionId, subscriptionId)
        )
      ),
    getSubscriptionTagCounts(db, userId, subscriptionId),
  ]);

  return {
    ...baseCounts,
    subscription: { id: subscriptionId, unread: subscriptionUnreadResult[0]?.unread ?? 0 },
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
  // The subscription's tag IDs are fetched alongside the grouped counts
  // (not derived from them): the counts query joins unread entries, so a tag
  // whose unread count dropped to zero produces no row. Every tag must still
  // be returned (with unread: 0) — the client sets these counts absolutely,
  // so an omitted tag would keep its stale badge.
  const [subTagRows, tagCounts] = await Promise.all([
    db
      .select({ tagId: subscriptionTags.tagId })
      .from(subscriptionTags)
      .where(eq(subscriptionTags.subscriptionId, subscriptionId)),
    // COUNT(DISTINCT) dedupes entries reachable through multiple subscriptions
    // of the same tag (overlapping subscription_feeds from redirect/merge
    // history), matching listTags semantics.
    db
      .select({
        tagId: subscriptionTags.tagId,
        unread: sql<number>`count(DISTINCT ${visibleEntries.id})::int`,
      })
      .from(subscriptionTags)
      .innerJoin(visibleEntries, eq(visibleEntries.subscriptionId, subscriptionTags.subscriptionId))
      // Scope to active subscriptions (user_feeds is active-only): visible_entries
      // also surfaces starred entries from unsubscribed feeds, which must not
      // inflate a tag's unread badge.
      .innerJoin(
        userFeeds,
        and(eq(userFeeds.id, visibleEntries.subscriptionId), eq(userFeeds.userId, userId))
      )
      .where(
        and(
          eq(visibleEntries.userId, userId),
          eq(visibleEntries.read, false),
          // Use a subquery to find all tags for this subscription, then count
          // entries for all subscriptions with those tags
          inArray(
            subscriptionTags.tagId,
            db
              .select({ tagId: subscriptionTags.tagId })
              .from(subscriptionTags)
              .where(eq(subscriptionTags.subscriptionId, subscriptionId))
          )
        )
      )
      .groupBy(subscriptionTags.tagId),
  ]);

  if (subTagRows.length > 0) {
    const unreadByTag = new Map(tagCounts.map((t) => [t.tagId, t.unread]));
    return {
      tags: subTagRows.map((t) => ({ id: t.tagId, unread: unreadByTag.get(t.tagId) ?? 0 })),
      uncategorized: null,
    };
  }

  // Subscription has no tags - get uncategorized count
  const uncategorizedResult = await db
    .select({
      unread: sql<number>`count(DISTINCT ${visibleEntries.id})::int`,
    })
    .from(visibleEntries)
    .innerJoin(
      userFeeds,
      and(eq(userFeeds.id, visibleEntries.subscriptionId), eq(userFeeds.userId, userId))
    )
    .where(
      and(
        eq(visibleEntries.userId, userId),
        eq(visibleEntries.read, false),
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

/**
 * Counts for multiple entries, with subscription and tag counts aggregated.
 * Used by markRead to return counts for all affected lists.
 */
export interface BulkUnreadCounts {
  // Always present
  all: { unread: number };
  starred: { unread: number };
  saved: { unread: number };

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
  db: DbOrTx,
  userId: string,
  entries: Array<{ subscriptionId: string | null; type: "web" | "email" | "saved" }>
): Promise<BulkUnreadCounts> {
  // Collect unique subscription IDs (excluding null for saved articles)
  const subscriptionIds = [
    ...new Set(entries.map((e) => e.subscriptionId).filter((id) => id !== null)),
  ] as string[];

  // Query 1: Get unread counts for global + starred + saved in one query.
  const globalCounts = await getGlobalUnreadCounts(db, userId);

  const baseCounts: BulkUnreadCounts = {
    all: { unread: globalCounts.allUnread },
    starred: { unread: globalCounts.starredUnread },
    saved: { unread: globalCounts.savedUnread },
    subscriptions: [],
    tags: [],
  };

  // If no subscriptions affected (all saved entries), return base counts
  if (subscriptionIds.length === 0) {
    return baseCounts;
  }

  // Queries 2 & 3: Run subscription counts and tag lookups in parallel
  const [subscriptionCounts, subTags] = await Promise.all([
    db
      .select({
        subscriptionId: visibleEntries.subscriptionId,
        unread: sql<number>`count(*)::int`,
      })
      .from(visibleEntries)
      .where(
        and(
          eq(visibleEntries.userId, userId),
          eq(visibleEntries.read, false),
          inArray(visibleEntries.subscriptionId, subscriptionIds)
        )
      )
      .groupBy(visibleEntries.subscriptionId),
    db
      .select({
        subscriptionId: subscriptionTags.subscriptionId,
        tagId: subscriptionTags.tagId,
      })
      .from(subscriptionTags)
      .where(inArray(subscriptionTags.subscriptionId, subscriptionIds)),
  ]);

  // Zero-fill: the grouped query only returns subscriptions that still have
  // unread entries, but the client sets these counts absolutely — omitting a
  // subscription whose last unread entry was just read would leave its stale
  // badge in place.
  const unreadBySubscription = new Map(
    subscriptionCounts
      .filter((s) => s.subscriptionId !== null)
      .map((s) => [s.subscriptionId!, s.unread])
  );
  baseCounts.subscriptions = subscriptionIds.map((id) => ({
    id,
    unread: unreadBySubscription.get(id) ?? 0,
  }));

  const tagIds = [...new Set(subTags.map((t) => t.tagId))];
  const subscriptionsWithTags = new Set(subTags.map((t) => t.subscriptionId));
  const hasUncategorized = subscriptionIds.some((id) => !subscriptionsWithTags.has(id));

  // Queries 4 & 5: Run tag counts and uncategorized count in parallel
  const [tagCounts, uncategorizedResult] = await Promise.all([
    tagIds.length > 0
      ? db
          .select({
            tagId: subscriptionTags.tagId,
            // COUNT(DISTINCT) for parity with listTags (see getSubscriptionTagCounts)
            unread: sql<number>`count(DISTINCT ${visibleEntries.id})::int`,
          })
          .from(subscriptionTags)
          .innerJoin(
            visibleEntries,
            eq(visibleEntries.subscriptionId, subscriptionTags.subscriptionId)
          )
          // Active subscriptions only (see getSubscriptionTagCounts).
          .innerJoin(
            userFeeds,
            and(eq(userFeeds.id, visibleEntries.subscriptionId), eq(userFeeds.userId, userId))
          )
          .where(
            and(
              eq(visibleEntries.userId, userId),
              eq(visibleEntries.read, false),
              inArray(subscriptionTags.tagId, tagIds)
            )
          )
          .groupBy(subscriptionTags.tagId)
      : Promise.resolve([]),
    hasUncategorized
      ? db
          .select({
            unread: sql<number>`count(DISTINCT ${visibleEntries.id})::int`,
          })
          .from(visibleEntries)
          .innerJoin(
            userFeeds,
            and(eq(userFeeds.id, visibleEntries.subscriptionId), eq(userFeeds.userId, userId))
          )
          .where(
            and(
              eq(visibleEntries.userId, userId),
              eq(visibleEntries.read, false),
              sql`NOT EXISTS (
              SELECT 1 FROM subscription_tags st
              WHERE st.subscription_id = ${userFeeds.id}
            )`
            )
          )
      : Promise.resolve(null),
  ]);

  // Zero-fill missing tags for the same reason as subscriptions above.
  const unreadByTag = new Map(tagCounts.map((t) => [t.tagId, t.unread]));
  baseCounts.tags = tagIds.map((id) => ({ id, unread: unreadByTag.get(id) ?? 0 }));

  if (uncategorizedResult) {
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
  // Query unread counts for global + starred + saved + subscription in one
  // scan. read=false in WHERE lets the partial idx_user_entries_unread index
  // drive; every aggregate is then a subset of unread. count(DISTINCT id)
  // dedupes entries reachable through overlapping subscription_feeds rows (see
  // getGlobalUnreadCounts).
  const result = await db
    .select({
      // Global unread counts
      allUnread: sql<number>`count(DISTINCT ${visibleEntries.id})::int`,
      // Starred unread counts
      starredUnread: sql<number>`count(DISTINCT ${visibleEntries.id}) FILTER (WHERE ${visibleEntries.starred})::int`,
      // Saved unread counts
      savedUnread: sql<number>`count(DISTINCT ${visibleEntries.id}) FILTER (WHERE ${visibleEntries.type} = 'saved')::int`,
      // Subscription count (only computed if subscriptionId provided)
      subscriptionUnread:
        subscriptionId !== null
          ? sql<number>`count(DISTINCT ${visibleEntries.id}) FILTER (WHERE ${visibleEntries.subscriptionId} = ${subscriptionId})::int`
          : sql<number>`0`,
    })
    .from(visibleEntries)
    .where(and(eq(visibleEntries.userId, userId), eq(visibleEntries.read, false)));

  const counts = result[0] ?? {
    allUnread: 0,
    starredUnread: 0,
    savedUnread: 0,
    subscriptionUnread: 0,
  };

  const baseCounts: UnreadCounts = {
    all: { unread: counts.allUnread },
    starred: { unread: counts.starredUnread },
  };

  // For saved articles, include saved counts
  if (entryType === "saved") {
    return {
      ...baseCounts,
      saved: { unread: counts.savedUnread },
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

/**
 * Computes absolute counts for the lists affected when a subscription is
 * removed: All Articles (+ starred/saved globals) plus either the
 * subscription's former tags or Uncategorized.
 *
 * Driven by explicit `formerTagIds` rather than a subscription ID because the
 * subscription's tag associations are deleted before this runs. Must be called
 * AFTER the subscription is soft-deleted so the counts reflect its removal.
 * `subscriptions` is always empty (the subscription is gone).
 *
 * @param db - Database instance
 * @param userId - User ID
 * @param formerTagIds - Tag IDs the subscription belonged to (empty = it was uncategorized)
 */
export async function getSubscriptionDeletionCounts(
  db: typeof dbType,
  userId: string,
  formerTagIds: string[]
): Promise<BulkUnreadCounts> {
  // Reuse the shared global-count query (see getGlobalUnreadCounts). Must run
  // AFTER the subscription is soft-deleted so its entries no longer count as
  // visible.
  const globalCounts = await getGlobalUnreadCounts(db, userId);
  const baseCounts: BulkUnreadCounts = {
    all: { unread: globalCounts.allUnread },
    starred: { unread: globalCounts.starredUnread },
    saved: { unread: globalCounts.savedUnread },
    subscriptions: [],
    tags: [],
  };

  if (formerTagIds.length === 0) {
    // Subscription was uncategorized — only Uncategorized's unread changed.
    const uncategorizedResult = await db
      .select({
        unread: sql<number>`count(DISTINCT ${visibleEntries.id}) FILTER (WHERE NOT ${visibleEntries.read})::int`,
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
    return baseCounts;
  }

  // Subscription had tags — recompute unread for each former tag. Tags that
  // dropped to zero won't appear in the grouped result, so default them to 0
  // (the client must set them, not skip them).
  const tagCounts = await db
    .select({
      tagId: subscriptionTags.tagId,
      unread: sql<number>`count(DISTINCT ${visibleEntries.id}) FILTER (WHERE NOT ${visibleEntries.read})::int`,
    })
    .from(subscriptionTags)
    .innerJoin(visibleEntries, eq(visibleEntries.subscriptionId, subscriptionTags.subscriptionId))
    .where(and(eq(visibleEntries.userId, userId), inArray(subscriptionTags.tagId, formerTagIds)))
    .groupBy(subscriptionTags.tagId);

  const unreadByTag = new Map(tagCounts.map((t) => [t.tagId, t.unread]));
  baseCounts.tags = formerTagIds.map((id) => ({ id, unread: unreadByTag.get(id) ?? 0 }));
  return baseCounts;
}

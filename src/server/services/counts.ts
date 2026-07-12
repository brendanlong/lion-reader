/**
 * Entry Counts Service
 *
 * Provides queries for fetching unread counts related to an entry.
 * Used by mutations and SSE events to return absolute counts for cache updates.
 *
 * All unread badges are computed from the trigger-maintained counters
 * (migration 0092: `subscriptions.unread_count` / `starred_unread_count`,
 * `users.saved_unread_count` / `starred_unread_count`) — O(subscriptions)
 * arithmetic instead of an O(unread-entries) scan over visible_entries.
 * Spam is permanently excluded from the counters, so it never counts toward
 * a badge. The badge algebra:
 *
 *   subscription  = s.unread_count
 *   tag           = SUM(unread_count) over the tag's ACTIVE subscriptions
 *   uncategorized = SUM(unread_count) over ACTIVE untagged subscriptions
 *   saved         = u.saved_unread_count
 *   starred       = u.starred_unread_count
 *   all           = SUM(unread_count)         over ACTIVE subscriptions
 *                 + u.saved_unread_count
 *                 + SUM(starred_unread_count) over INACTIVE subscriptions
 *
 * The last term of `all` is the starred-orphans correction: starred entries
 * of unsubscribed subscriptions stay visible, and their (still trigger-
 * maintained) counters live on the dead subscription rows. Deriving the term
 * from `unsubscribed_at` at read time means unsubscribe/resubscribe/merge
 * need zero counter writes.
 */

import { eq, and, sql, inArray, isNull } from "drizzle-orm";
import type { db as dbType, DbOrTx } from "@/server/db";
import { visibleEntries, subscriptionTags, subscriptions, users } from "@/server/db/schema";

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
 * Global unread counts (all + starred + saved) for a user, computed with the
 * badge algebra (see the file header): one arithmetic query over the user's
 * subscription rows LEFT-JOINed to the users row. LEFT JOIN so a user with no
 * subscriptions still gets their saved/starred counters back.
 */
export async function getGlobalUnreadCounts(
  db: DbOrTx,
  userId: string
): Promise<{ allUnread: number; starredUnread: number; savedUnread: number }> {
  const result = await db
    .select({
      allUnread: sql<number>`(
        COALESCE(sum(${subscriptions.unreadCount}) FILTER (WHERE ${subscriptions.unsubscribedAt} IS NULL), 0)
        + ${users.savedUnreadCount}
        + COALESCE(sum(${subscriptions.starredUnreadCount}) FILTER (WHERE ${subscriptions.unsubscribedAt} IS NOT NULL), 0)
      )::int`,
      starredUnread: users.starredUnreadCount,
      savedUnread: users.savedUnreadCount,
    })
    .from(users)
    .leftJoin(subscriptions, eq(subscriptions.userId, users.id))
    .where(eq(users.id, userId))
    .groupBy(users.id, users.savedUnreadCount, users.starredUnreadCount);
  return result[0] ?? { allUnread: 0, starredUnread: 0, savedUnread: 0 };
}

/**
 * Fetches unread counts for all lists an entry belongs to.
 *
 * The entry's context (subscription, type) is looked up through
 * visible_entries; every count is counter arithmetic.
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

  // Read the subscription's counter and the tag/uncategorized sums in parallel
  const [subscriptionUnreadResult, tagResult] = await Promise.all([
    db
      .select({ unread: subscriptions.unreadCount })
      .from(subscriptions)
      .where(and(eq(subscriptions.id, subscriptionId), eq(subscriptions.userId, userId)))
      .limit(1),
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
 * Uncategorized unread count: SUM of unread counters over the user's ACTIVE
 * subscriptions with no subscription_tags row. Aggregate without GROUP BY, so
 * it always returns exactly one row (COALESCEd to 0 when no rows match).
 */
function uncategorizedUnreadQuery(db: DbOrTx, userId: string) {
  return db
    .select({
      unread: sql<number>`COALESCE(sum(${subscriptions.unreadCount}), 0)::int`,
    })
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.userId, userId),
        isNull(subscriptions.unsubscribedAt),
        sql`NOT EXISTS (
          SELECT 1 FROM subscription_tags st
          WHERE st.subscription_id = ${subscriptions.id}
        )`
      )
    );
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
  // The subscription's tag IDs are fetched alongside the summed counts
  // (not derived from them): the counts query joins active subscriptions, so a
  // tag whose unread count dropped to zero (or whose subscriptions are all
  // inactive) produces no row. Every tag must still be returned (with
  // unread: 0) — the client sets these counts absolutely, so an omitted tag
  // would keep its stale badge.
  const [subTagRows, tagCounts] = await Promise.all([
    db
      .select({ tagId: subscriptionTags.tagId })
      .from(subscriptionTags)
      .where(eq(subscriptionTags.subscriptionId, subscriptionId)),
    // Per-tag SUM of subscription counters over each tag's ACTIVE
    // subscriptions, for every tag on this subscription (found via the
    // subquery). subscription_tags is unique per (tag, subscription), so each
    // subscription's counter contributes exactly once per tag.
    db
      .select({
        tagId: subscriptionTags.tagId,
        unread: sql<number>`sum(${subscriptions.unreadCount})::int`,
      })
      .from(subscriptionTags)
      // Active subscriptions only: starred orphans on unsubscribed feeds
      // belong to Starred, not to a tag's unread badge.
      .innerJoin(
        subscriptions,
        and(
          eq(subscriptions.id, subscriptionTags.subscriptionId),
          eq(subscriptions.userId, userId),
          isNull(subscriptions.unsubscribedAt)
        )
      )
      .where(
        inArray(
          subscriptionTags.tagId,
          db
            .select({ tagId: subscriptionTags.tagId })
            .from(subscriptionTags)
            .where(eq(subscriptionTags.subscriptionId, subscriptionId))
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
  const uncategorizedResult = await uncategorizedUnreadQuery(db, userId);

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

  // Query 1: global + starred + saved counter arithmetic.
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

  // Queries 2 & 3: Read the subscription counters and tag lookups in parallel
  const [subscriptionCounts, subTags] = await Promise.all([
    db
      .select({
        subscriptionId: subscriptions.id,
        unread: subscriptions.unreadCount,
      })
      .from(subscriptions)
      .where(and(eq(subscriptions.userId, userId), inArray(subscriptions.id, subscriptionIds))),
    db
      .select({
        subscriptionId: subscriptionTags.subscriptionId,
        tagId: subscriptionTags.tagId,
      })
      .from(subscriptionTags)
      .where(inArray(subscriptionTags.subscriptionId, subscriptionIds)),
  ]);

  // Zero-fill: a requested subscription the counter query didn't return (e.g.
  // deleted out from under us) must still appear — the client sets these
  // counts absolutely, so omitting a subscription would leave a stale badge.
  const unreadBySubscription = new Map(subscriptionCounts.map((s) => [s.subscriptionId, s.unread]));
  baseCounts.subscriptions = subscriptionIds.map((id) => ({
    id,
    unread: unreadBySubscription.get(id) ?? 0,
  }));

  const tagIds = [...new Set(subTags.map((t) => t.tagId))];
  const subscriptionsWithTags = new Set(subTags.map((t) => t.subscriptionId));
  const hasUncategorized = subscriptionIds.some((id) => !subscriptionsWithTags.has(id));

  // Queries 4 & 5: Run tag sums and uncategorized sum in parallel
  const [tagCounts, uncategorizedResult] = await Promise.all([
    tagIds.length > 0
      ? db
          .select({
            tagId: subscriptionTags.tagId,
            // Per-tag SUM over active subscriptions (see getSubscriptionTagCounts)
            unread: sql<number>`sum(${subscriptions.unreadCount})::int`,
          })
          .from(subscriptionTags)
          .innerJoin(
            subscriptions,
            and(
              eq(subscriptions.id, subscriptionTags.subscriptionId),
              eq(subscriptions.userId, userId),
              isNull(subscriptions.unsubscribedAt)
            )
          )
          .where(inArray(subscriptionTags.tagId, tagIds))
          .groupBy(subscriptionTags.tagId)
      : Promise.resolve([]),
    hasUncategorized ? uncategorizedUnreadQuery(db, userId) : Promise.resolve(null),
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
  // Global counter arithmetic + the subscription's counter (when provided).
  const [counts, subscriptionRows] = await Promise.all([
    getGlobalUnreadCounts(db, userId),
    subscriptionId !== null
      ? db
          .select({ unread: subscriptions.unreadCount })
          .from(subscriptions)
          .where(and(eq(subscriptions.id, subscriptionId), eq(subscriptions.userId, userId)))
          .limit(1)
      : Promise.resolve([]),
  ]);

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
    subscription: { id: subscriptionId, unread: subscriptionRows[0]?.unread ?? 0 },
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
 * AFTER the subscription is soft-deleted so its counter no longer contributes
 * to the active-subscription sums. `subscriptions` is always empty (the
 * subscription is gone).
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
  // Reuse the shared global arithmetic (see getGlobalUnreadCounts). Must run
  // AFTER the subscription is soft-deleted so its unread counter drops out of
  // the active sum (only its starred orphans keep counting toward `all`).
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
    const uncategorizedResult = await uncategorizedUnreadQuery(db, userId);
    baseCounts.uncategorized = { unread: uncategorizedResult[0]?.unread ?? 0 };
    return baseCounts;
  }

  // Subscription had tags — recompute unread for each former tag. Tags whose
  // remaining subscriptions are all inactive (or that dropped to zero) won't
  // appear in the grouped result, so default them to 0 (the client must set
  // them, not skip them).
  const tagCounts = await db
    .select({
      tagId: subscriptionTags.tagId,
      unread: sql<number>`sum(${subscriptions.unreadCount})::int`,
    })
    .from(subscriptionTags)
    .innerJoin(
      subscriptions,
      and(
        eq(subscriptions.id, subscriptionTags.subscriptionId),
        eq(subscriptions.userId, userId),
        isNull(subscriptions.unsubscribedAt)
      )
    )
    .where(inArray(subscriptionTags.tagId, formerTagIds))
    .groupBy(subscriptionTags.tagId);

  const unreadByTag = new Map(tagCounts.map((t) => [t.tagId, t.unread]));
  baseCounts.tags = formerTagIds.map((id) => ({ id, unread: unreadByTag.get(id) ?? 0 }));
  return baseCounts;
}

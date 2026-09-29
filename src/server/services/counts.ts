/**
 * Entry Counts Service
 *
 * Provides queries for fetching unread counts related to entries.
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
import { subscriptionTags, subscriptions, users } from "@/server/db/schema";

// ============================================================================
// Types
// ============================================================================

/**
 * Tag unread count.
 */
export interface TagCount {
  id: string;
  unread: number;
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
 * Per-tag unread counts: SUM of unread counters over each tag's ACTIVE
 * subscriptions (starred orphans on unsubscribed feeds belong to Starred, not
 * to a tag's badge). subscription_tags is unique per (tag, subscription), so
 * each subscription's counter contributes exactly once per tag.
 *
 * Every requested tag is returned, zero-filled: a tag whose unread count
 * dropped to zero (or whose subscriptions are all inactive) produces no grouped
 * row, and the client sets these counts absolutely, so an omitted tag would
 * keep its stale badge.
 */
async function getTagUnreadCounts(
  db: DbOrTx,
  userId: string,
  tagIds: string[]
): Promise<TagCount[]> {
  if (tagIds.length === 0) {
    return [];
  }
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
    .where(inArray(subscriptionTags.tagId, tagIds))
    .groupBy(subscriptionTags.tagId);

  const unreadByTag = new Map(tagCounts.map((t) => [t.tagId, t.unread]));
  return tagIds.map((id) => ({ id, unread: unreadByTag.get(id) ?? 0 }));
}

/**
 * Counts for multiple entries, with subscription and tag counts aggregated.
 * Used by markRead, star/unstar, and new_entry events to return counts for all
 * affected lists.
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

  // The global counter arithmetic runs alongside the subscription counter and
  // tag lookups; the latter are skipped when only saved entries are affected.
  const [globalCounts, subscriptionCounts, subTags] = await Promise.all([
    getGlobalUnreadCounts(db, userId),
    subscriptionIds.length > 0
      ? db
          .select({
            subscriptionId: subscriptions.id,
            unread: subscriptions.unreadCount,
          })
          .from(subscriptions)
          .where(and(eq(subscriptions.userId, userId), inArray(subscriptions.id, subscriptionIds)))
      : Promise.resolve([]),
    subscriptionIds.length > 0
      ? db
          .select({
            subscriptionId: subscriptionTags.subscriptionId,
            tagId: subscriptionTags.tagId,
          })
          .from(subscriptionTags)
          .where(inArray(subscriptionTags.subscriptionId, subscriptionIds))
      : Promise.resolve([]),
  ]);

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

  // Tag sums and the uncategorized sum in parallel
  const [tagCounts, uncategorizedResult] = await Promise.all([
    getTagUnreadCounts(db, userId, tagIds),
    hasUncategorized ? uncategorizedUnreadQuery(db, userId) : Promise.resolve(null),
  ]);
  baseCounts.tags = tagCounts;

  if (uncategorizedResult) {
    baseCounts.uncategorized = { unread: uncategorizedResult[0]?.unread ?? 0 };
  }

  return baseCounts;
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

  // Subscription had tags — recompute unread for each former tag.
  baseCounts.tags = await getTagUnreadCounts(db, userId, formerTagIds);
  return baseCounts;
}

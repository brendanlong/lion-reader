/**
 * Entry Counts Service
 *
 * Provides queries for fetching unread counts related to entries.
 * Used by mutations and SSE events to return absolute counts for cache updates.
 *
 * Every unread badge is a trigger-maintained counter (spam excluded), read
 * directly — never a scan:
 *
 *   subscription  = subscriptions.unread_count (a collection's counts its members)
 *   tag           = tags.unread_count
 *   uncategorized = users.uncategorized_unread_count
 *   saved         = users.saved_unread_count
 *   starred       = users.starred_unread_count
 *   all           = users.all_unread_count
 *
 * Tag, Uncategorized and All count distinct articles: one reachable through
 * both a feed and a collection (#1806) counts once. The database functions
 * `apply_unread_rows` and `recompute_list_counters` maintain them.
 */

import { eq, and, inArray } from "drizzle-orm";
import type { db as dbType, DbOrTx } from "@/server/db";
import {
  collectionEntries,
  subscriptionTags,
  subscriptions,
  tags,
  users,
} from "@/server/db/schema";

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

interface UserUnreadCounts {
  allUnread: number;
  starredUnread: number;
  savedUnread: number;
  uncategorizedUnread: number;
}

async function getUserUnreadCounts(db: DbOrTx, userId: string): Promise<UserUnreadCounts> {
  const [row] = await db
    .select({
      allUnread: users.allUnreadCount,
      starredUnread: users.starredUnreadCount,
      savedUnread: users.savedUnreadCount,
      uncategorizedUnread: users.uncategorizedUnreadCount,
    })
    .from(users)
    .where(eq(users.id, userId));
  return row ?? { allUnread: 0, starredUnread: 0, savedUnread: 0, uncategorizedUnread: 0 };
}

/** Global unread counts (all + starred + saved) for a user. */
export async function getGlobalUnreadCounts(
  db: DbOrTx,
  userId: string
): Promise<{ allUnread: number; starredUnread: number; savedUnread: number }> {
  const { allUnread, starredUnread, savedUnread } = await getUserUnreadCounts(db, userId);
  return { allUnread, starredUnread, savedUnread };
}

/**
 * Per-tag unread counts. Every requested tag is returned, zero-filled: the
 * client sets these counts absolutely, so an omitted tag would keep its stale
 * badge.
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
    .select({ tagId: tags.id, unread: tags.unreadCount })
    .from(tags)
    .where(and(eq(tags.userId, userId), inArray(tags.id, tagIds)));

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
 * @param entries - Each entry's source subscription, plus its id when it may
 *   already be in collections (whose counts are then included too)
 * @returns Aggregated unread counts for all affected lists
 */
export async function getBulkEntryRelatedCounts(
  db: DbOrTx,
  userId: string,
  entries: Array<{ id?: string; subscriptionId: string | null }>
): Promise<BulkUnreadCounts> {
  const entryIds = entries.map((e) => e.id).filter((id) => id !== undefined);
  const collectionIds =
    entryIds.length > 0
      ? (
          await db
            .selectDistinct({ id: collectionEntries.subscriptionId })
            .from(collectionEntries)
            .where(
              and(
                eq(collectionEntries.userId, userId),
                inArray(collectionEntries.entryId, entryIds)
              )
            )
        ).map((row) => row.id)
      : [];

  // Collect unique subscription IDs (excluding null for saved articles)
  const subscriptionIds = [
    ...new Set([
      ...entries.map((e) => e.subscriptionId).filter((id) => id !== null),
      ...collectionIds,
    ]),
  ];

  // The global counter arithmetic runs alongside the subscription counter and
  // tag lookups; the latter are skipped when only saved entries are affected.
  const [userCounts, subscriptionCounts, subTags] = await Promise.all([
    getUserUnreadCounts(db, userId),
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
    all: { unread: userCounts.allUnread },
    starred: { unread: userCounts.starredUnread },
    saved: { unread: userCounts.savedUnread },
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

  baseCounts.tags = await getTagUnreadCounts(db, userId, tagIds);
  if (hasUncategorized) {
    baseCounts.uncategorized = { unread: userCounts.uncategorizedUnread };
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
 * after the subscription is soft-deleted. `subscriptions` is always empty (the
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
  const userCounts = await getUserUnreadCounts(db, userId);
  const baseCounts: BulkUnreadCounts = {
    all: { unread: userCounts.allUnread },
    starred: { unread: userCounts.starredUnread },
    saved: { unread: userCounts.savedUnread },
    subscriptions: [],
    tags: [],
  };

  if (formerTagIds.length === 0) {
    // Subscription was uncategorized — only Uncategorized's unread changed.
    baseCounts.uncategorized = { unread: userCounts.uncategorizedUnread };
    return baseCounts;
  }

  // Subscription had tags — recompute unread for each former tag.
  baseCounts.tags = await getTagUnreadCounts(db, userId, formerTagIds);
  return baseCounts;
}

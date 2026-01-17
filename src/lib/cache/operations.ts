/**
 * Cache Operations
 *
 * Higher-level functions for cache updates that handle all the interactions
 * between different caches. These are the primary API for mutations and SSE
 * handlers - they don't need to know which low-level caches to update.
 *
 * Operations look up entry state from cache to handle interactions correctly:
 * - Starring an unread entry affects the starred unread count
 * - Marking a starred entry read affects the starred unread count
 */

import type { TRPCClientUtils } from "@/lib/trpc/client";
import {
  updateEntriesReadStatus,
  updateEntryStarredStatus,
  adjustSubscriptionUnreadCounts,
  adjustTagUnreadCounts,
  adjustEntriesCount,
  calculateTagDeltasFromSubscriptions,
  addSubscriptionToCache,
  removeSubscriptionFromCache,
} from "./index";

/**
 * Entry type (matches feed type schema).
 */
export type EntryType = "web" | "email" | "saved";

/**
 * Entry with context, as returned by markRead mutation.
 * Includes all state needed for cache updates.
 */
export interface EntryWithContext {
  id: string;
  subscriptionId: string | null;
  starred: boolean;
  type: EntryType;
}

/**
 * Subscription data for adding to cache.
 */
export interface SubscriptionData {
  id: string;
  type: "web" | "email" | "saved";
  url: string | null;
  title: string | null;
  originalTitle: string | null;
  description: string | null;
  siteUrl: string | null;
  subscribedAt: Date;
  unreadCount: number;
  tags: Array<{ id: string; name: string; color: string | null }>;
  fetchFullContent: boolean;
}

/**
 * Handles entries being marked as read or unread.
 *
 * Updates:
 * - entries.get cache for each entry
 * - subscriptions.list unread counts
 * - tags.list unread counts
 * - entries.count({ starredOnly: true }) for starred entries
 * - entries.count({ type: "saved" }) for saved entries
 *
 * Note: Does NOT invalidate entries.list - entries stay visible until navigation.
 * Lists have refetchOnMount: true, so they'll refetch on next navigation.
 *
 * @param utils - tRPC utils for cache access
 * @param entries - Entries with their context (subscriptionId, starred, type)
 * @param read - New read status
 */
export function handleEntriesMarkedRead(
  utils: TRPCClientUtils,
  entries: EntryWithContext[],
  read: boolean
): void {
  if (entries.length === 0) return;

  // 1. Update entry read status in entries.get cache + invalidate lists
  updateEntriesReadStatus(
    utils,
    entries.map((e) => e.id),
    read
  );

  // 2. Calculate subscription deltas
  // Marking read: -1, marking unread: +1
  const delta = read ? -1 : 1;
  const subscriptionDeltas = new Map<string, number>();

  for (const entry of entries) {
    if (entry.subscriptionId) {
      const current = subscriptionDeltas.get(entry.subscriptionId) ?? 0;
      subscriptionDeltas.set(entry.subscriptionId, current + delta);
    }
  }

  // 3. Update subscription unread counts
  adjustSubscriptionUnreadCounts(utils, subscriptionDeltas);

  // 4. Calculate and update tag unread counts
  const tagDeltas = calculateTagDeltasFromSubscriptions(utils, subscriptionDeltas);
  adjustTagUnreadCounts(utils, tagDeltas);

  // 5. Update starred unread count - only for entries that are starred
  const starredCount = entries.filter((e) => e.starred).length;
  if (starredCount > 0) {
    adjustEntriesCount(utils, { starredOnly: true }, delta * starredCount);
  }

  // 6. Update saved unread count - only for saved entries
  const savedCount = entries.filter((e) => e.type === "saved").length;
  if (savedCount > 0) {
    adjustEntriesCount(utils, { type: "saved" }, delta * savedCount);
  }
}

/**
 * Handles an entry being starred.
 *
 * Updates:
 * - entries.get cache
 * - entries.count({ starredOnly: true }) - total +1, unread +1 if entry is unread
 *
 * Note: Does NOT invalidate entries.list - entries stay visible until navigation.
 *
 * @param utils - tRPC utils for cache access
 * @param entryId - Entry ID being starred
 * @param read - Whether the entry is read (from server response)
 */
export function handleEntryStarred(utils: TRPCClientUtils, entryId: string, read: boolean): void {
  // 1. Update entry starred status
  updateEntryStarredStatus(utils, entryId, true);

  // 2. Update starred count
  // Total always +1, unread +1 only if entry is unread
  adjustEntriesCount(utils, { starredOnly: true }, read ? 0 : 1, 1);
}

/**
 * Handles an entry being unstarred.
 *
 * Updates:
 * - entries.get cache
 * - entries.count({ starredOnly: true }) - total -1, unread -1 if entry is unread
 *
 * Note: Does NOT invalidate entries.list - entries stay visible until navigation.
 *
 * @param utils - tRPC utils for cache access
 * @param entryId - Entry ID being unstarred
 * @param read - Whether the entry is read (from server response)
 */
export function handleEntryUnstarred(utils: TRPCClientUtils, entryId: string, read: boolean): void {
  // 1. Update entry starred status
  updateEntryStarredStatus(utils, entryId, false);

  // 2. Update starred count
  // Total always -1, unread -1 only if entry was unread
  adjustEntriesCount(utils, { starredOnly: true }, read ? 0 : -1, -1);
}

/**
 * Handles a new subscription being created.
 *
 * Updates:
 * - subscriptions.list (add subscription)
 * - tags.list (invalidated - may affect tag counts)
 *
 * @param utils - tRPC utils for cache access
 * @param subscription - The new subscription data
 */
export function handleSubscriptionCreated(
  utils: TRPCClientUtils,
  subscription: SubscriptionData
): void {
  addSubscriptionToCache(utils, subscription);
  // Tags may need updating if subscription uses existing tags
  utils.tags.list.invalidate();
}

/**
 * Handles a subscription being deleted.
 *
 * Updates:
 * - subscriptions.list (remove subscription)
 * - entries.list (invalidated - entries may be filtered out)
 * - tags.list (invalidated - tag counts change)
 *
 * @param utils - tRPC utils for cache access
 * @param subscriptionId - ID of the deleted subscription
 */
export function handleSubscriptionDeleted(utils: TRPCClientUtils, subscriptionId: string): void {
  removeSubscriptionFromCache(utils, subscriptionId);
  utils.entries.list.invalidate();
  utils.tags.list.invalidate();
}

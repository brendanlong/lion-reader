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

import type { QueryClient } from "@tanstack/react-query";
import type { TRPCClientUtils } from "@/lib/trpc/client";
import {
  updateEntriesReadStatus,
  updateEntryStarredStatus,
  updateEntryScoreInCache,
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

// ============================================================================
// Private Helpers (shared logic to avoid duplication)
// ============================================================================

/**
 * Updates subscription and tag unread counts based on deltas.
 * Shared logic used by multiple operations to ensure consistent behavior.
 *
 * @param utils - tRPC utils for cache access
 * @param subscriptionDeltas - Map of subscriptionId -> unread count delta
 * @param queryClient - React Query client for updating infinite query caches
 */
function updateSubscriptionAndTagCounts(
  utils: TRPCClientUtils,
  subscriptionDeltas: Map<string, number>,
  queryClient?: QueryClient
): void {
  adjustSubscriptionUnreadCounts(utils, subscriptionDeltas, queryClient);
  const { tagDeltas, uncategorizedDelta } = calculateTagDeltasFromSubscriptions(
    utils,
    subscriptionDeltas,
    queryClient
  );
  adjustTagUnreadCounts(utils, tagDeltas, uncategorizedDelta);
}

/**
 * Handles entries being marked as read or unread.
 *
 * Updates:
 * - entries.get cache for each entry
 * - entries.list cache (updates in place, no refetch)
 * - subscriptions.list unread counts
 * - tags.list unread counts
 * - entries.count({ starredOnly: true }) for starred entries
 * - entries.count({ type: "saved" }) for saved entries
 *
 * Note: Does NOT invalidate entries.list - entries stay visible until navigation.
 * useEntryListQuery refetches on pathname change, so lists update on next navigation.
 *
 * @param utils - tRPC utils for cache access
 * @param entries - Entries with their context (subscriptionId, starred, type)
 * @param read - New read status
 * @param queryClient - React Query client (optional, for list cache updates)
 */
export function handleEntriesMarkedRead(
  utils: TRPCClientUtils,
  entries: EntryWithContext[],
  read: boolean,
  queryClient?: QueryClient
): void {
  if (entries.length === 0) return;

  // 1. Update entry read status in entries.get cache and entries.list cache
  updateEntriesReadStatus(
    utils,
    entries.map((e) => e.id),
    read,
    queryClient
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

  // 3. Update subscription and tag unread counts (including per-tag infinite queries)
  updateSubscriptionAndTagCounts(utils, subscriptionDeltas, queryClient);

  // 4. Update All Articles unread count
  adjustEntriesCount(utils, {}, delta * entries.length);

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
 * - entries.list cache (updates in place, no refetch)
 * - entries.count({ starredOnly: true }) - total +1, unread +1 if entry is unread
 *
 * Note: Does NOT invalidate entries.list - entries stay visible until navigation.
 *
 * @param utils - tRPC utils for cache access
 * @param entryId - Entry ID being starred
 * @param read - Whether the entry is read (from server response)
 * @param queryClient - React Query client (optional, for list cache updates)
 */
export function handleEntryStarred(
  utils: TRPCClientUtils,
  entryId: string,
  read: boolean,
  queryClient?: QueryClient
): void {
  // 1. Update entry starred status
  updateEntryStarredStatus(utils, entryId, true, queryClient);

  // 2. Update starred count
  // Total always +1, unread +1 only if entry is unread
  adjustEntriesCount(utils, { starredOnly: true }, read ? 0 : 1, 1);
}

/**
 * Handles an entry being unstarred.
 *
 * Updates:
 * - entries.get cache
 * - entries.list cache (updates in place, no refetch)
 * - entries.count({ starredOnly: true }) - total -1, unread -1 if entry is unread
 *
 * Note: Does NOT invalidate entries.list - entries stay visible until navigation.
 *
 * @param utils - tRPC utils for cache access
 * @param entryId - Entry ID being unstarred
 * @param read - Whether the entry is read (from server response)
 * @param queryClient - React Query client (optional, for list cache updates)
 */
export function handleEntryUnstarred(
  utils: TRPCClientUtils,
  entryId: string,
  read: boolean,
  queryClient?: QueryClient
): void {
  // 1. Update entry starred status
  updateEntryStarredStatus(utils, entryId, false, queryClient);

  // 2. Update starred count
  // Total always -1, unread -1 only if entry was unread
  adjustEntriesCount(utils, { starredOnly: true }, read ? 0 : -1, -1);
}

/**
 * Handles an entry's score being changed.
 *
 * Updates:
 * - entries.get cache (score, implicitScore)
 * - entries.list cache (score, implicitScore)
 *
 * Score changes don't affect unread counts, subscription counts, or tag counts.
 *
 * @param utils - tRPC utils for cache access
 * @param entryId - Entry ID whose score changed
 * @param score - New explicit score (null if cleared)
 * @param implicitScore - New implicit score
 * @param queryClient - React Query client (optional, for list cache updates)
 */
export function handleEntryScoreChanged(
  utils: TRPCClientUtils,
  entryId: string,
  score: number | null,
  implicitScore: number,
  queryClient?: QueryClient
): void {
  updateEntryScoreInCache(utils, entryId, score, implicitScore, queryClient);
}

/**
 * Handles a new subscription being created.
 *
 * Updates:
 * - subscriptions.list (add subscription to unparameterized cache)
 * - subscriptions.list per-tag infinite queries (invalidated - alphabetical order may change)
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
  // Invalidate per-tag infinite queries so sidebar refetches with correct alphabetical order
  utils.subscriptions.list.invalidate();
  // Tags may need updating if subscription uses existing tags
  utils.tags.list.invalidate();
  // All Articles count may change with new subscription
  utils.entries.count.invalidate();
}

/**
 * Handles a subscription being deleted.
 *
 * Updates:
 * - subscriptions.list (remove subscription from unparameterized cache)
 * - subscriptions.list per-tag infinite queries (invalidated - list changed)
 * - entries.list (invalidated - entries may be filtered out)
 * - tags.list (invalidated - tag counts change)
 *
 * @param utils - tRPC utils for cache access
 * @param subscriptionId - ID of the deleted subscription
 */
export function handleSubscriptionDeleted(utils: TRPCClientUtils, subscriptionId: string): void {
  removeSubscriptionFromCache(utils, subscriptionId);
  // Invalidate per-tag infinite queries so sidebar refetches after removal
  utils.subscriptions.list.invalidate();
  utils.entries.list.invalidate();
  utils.tags.list.invalidate();
  utils.entries.count.invalidate();
}

/**
 * Handles a new entry being created in a subscription.
 *
 * Updates:
 * - subscriptions.list unread counts (+1)
 * - tags.list unread counts (+1)
 * - entries.count({ type: "saved" }) if entry is saved
 *
 * Does NOT invalidate entries.list - new entries appear on next navigation.
 * Note: We don't have full entry data from SSE events, so we can't update
 * entries.get or entries.list caches. That's OK - entries will be fetched
 * when user navigates to that view (useEntryListQuery refetches on pathname change).
 *
 * @param utils - tRPC utils for cache access
 * @param subscriptionId - Subscription the entry belongs to
 * @param feedType - Type of feed (web, email, saved)
 * @param queryClient - React Query client for updating infinite query caches
 */
export function handleNewEntry(
  utils: TRPCClientUtils,
  subscriptionId: string,
  feedType: "web" | "email" | "saved",
  queryClient?: QueryClient
): void {
  // New entries are always unread (read: false, starred: false)
  const subscriptionDeltas = new Map<string, number>();
  subscriptionDeltas.set(subscriptionId, 1); // +1 unread

  // Update subscription and tag unread counts (including per-tag infinite queries)
  updateSubscriptionAndTagCounts(utils, subscriptionDeltas, queryClient);

  // Update All Articles unread count (+1 unread, +1 total)
  adjustEntriesCount(utils, {}, 1, 1);

  // Update saved unread count if it's a saved entry
  if (feedType === "saved") {
    adjustEntriesCount(utils, { type: "saved" }, 1, 1);
  }
}

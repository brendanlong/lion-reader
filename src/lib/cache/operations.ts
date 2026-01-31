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
  findCachedSubscription,
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
 * Query key input type for subscriptions.list.
 */
interface SubscriptionListInput {
  tagId?: string;
  uncategorized?: boolean;
  query?: string;
  unreadOnly?: boolean;
  cursor?: string;
  limit?: number;
}

/**
 * Invalidates subscription list queries for specific tags.
 * More targeted than invalidating all subscription lists.
 *
 * @param queryClient - React Query client
 * @param tagIds - Tag IDs to invalidate queries for
 * @param includeUncategorized - Whether to also invalidate the uncategorized query
 */
function invalidateSubscriptionListsForTags(
  queryClient: QueryClient,
  tagIds: string[],
  includeUncategorized: boolean
): void {
  const tagIdSet = new Set(tagIds);

  // Get all subscription list queries
  const queries = queryClient.getQueriesData<unknown>({
    queryKey: [["subscriptions", "list"]],
  });

  for (const [queryKey] of queries) {
    // Query key structure: [["subscriptions", "list"], { input: {...}, type: "query"|"infinite" }]
    const keyData = queryKey[1] as { input?: SubscriptionListInput; type?: string } | undefined;
    const input = keyData?.input;

    // Always invalidate the unparameterized query (used by entry content pages)
    if (!input) {
      queryClient.invalidateQueries({ queryKey });
      continue;
    }

    // Invalidate if this query is for one of the affected tags
    if (input.tagId && tagIdSet.has(input.tagId)) {
      queryClient.invalidateQueries({ queryKey });
      continue;
    }

    // Invalidate uncategorized query if needed
    if (includeUncategorized && input.uncategorized === true) {
      queryClient.invalidateQueries({ queryKey });
    }
  }
}

/**
 * Page structure in subscription infinite query cache.
 */
interface CachedSubscriptionPage {
  items: Array<{ id: string; [key: string]: unknown }>;
  nextCursor?: string;
}

/**
 * Infinite query data structure for subscriptions.
 */
interface SubscriptionInfiniteData {
  pages: CachedSubscriptionPage[];
  pageParams: unknown[];
}

/**
 * Removes a subscription from all infinite query caches.
 * Used when unsubscribing to immediately remove from sidebar lists.
 *
 * @param queryClient - React Query client
 * @param subscriptionId - ID of the subscription to remove
 */
function removeSubscriptionFromInfiniteQueries(
  queryClient: QueryClient,
  subscriptionId: string
): void {
  const infiniteQueries = queryClient.getQueriesData<SubscriptionInfiniteData>({
    queryKey: [["subscriptions", "list"]],
  });

  for (const [queryKey, data] of infiniteQueries) {
    // Only update infinite queries (they have pages array)
    if (!data?.pages) continue;

    // Check if any page contains this subscription
    const hasSubscription = data.pages.some((page) =>
      page.items.some((s) => s.id === subscriptionId)
    );

    if (hasSubscription) {
      queryClient.setQueryData<SubscriptionInfiniteData>(queryKey, {
        ...data,
        pages: data.pages.map((page) => ({
          ...page,
          items: page.items.filter((s) => s.id !== subscriptionId),
        })),
      });
    }
  }
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
 * - subscriptions.list per-tag infinite queries (only affected tags, or uncategorized if no tags)
 * - tags.list (direct update of feedCount and unreadCount)
 * - entries.count (direct update)
 *
 * @param utils - tRPC utils for cache access
 * @param subscription - The new subscription data
 * @param queryClient - React Query client for targeted invalidations
 */
export function handleSubscriptionCreated(
  utils: TRPCClientUtils,
  subscription: SubscriptionData,
  queryClient?: QueryClient
): void {
  addSubscriptionToCache(utils, subscription);

  // Invalidate only the affected subscription list queries
  // - The unparameterized query (no input) for entry content pages
  // - Per-tag queries for tags the subscription belongs to
  // - Uncategorized query if subscription has no tags
  if (queryClient) {
    invalidateSubscriptionListsForTags(
      queryClient,
      subscription.tags.map((t) => t.id),
      subscription.tags.length === 0
    );
  } else {
    // Fallback: invalidate all subscription lists
    utils.subscriptions.list.invalidate();
  }

  // Directly update tags.list with feedCount and unreadCount changes
  utils.tags.list.setData(undefined, (oldData) => {
    if (!oldData) return oldData;

    if (subscription.tags.length === 0) {
      // Uncategorized subscription
      return {
        ...oldData,
        uncategorized: {
          feedCount: oldData.uncategorized.feedCount + 1,
          unreadCount: oldData.uncategorized.unreadCount + subscription.unreadCount,
        },
      };
    }

    // Update feedCount and unreadCount for each tag the subscription belongs to
    const tagIds = new Set(subscription.tags.map((t) => t.id));
    return {
      ...oldData,
      items: oldData.items.map((tag) => {
        if (tagIds.has(tag.id)) {
          return {
            ...tag,
            feedCount: tag.feedCount + 1,
            unreadCount: tag.unreadCount + subscription.unreadCount,
          };
        }
        return tag;
      }),
    };
  });

  // Directly update entries.count for All Articles
  adjustEntriesCount(utils, {}, subscription.unreadCount, subscription.unreadCount);
}

/**
 * Handles a subscription being deleted.
 *
 * Updates:
 * - subscriptions.list (remove subscription from caches)
 * - subscriptions.list per-tag infinite queries (only affected tags, or uncategorized)
 * - entries.list (invalidated - entries may be filtered out)
 * - tags.list (direct update of feedCount and unreadCount if subscription found in cache)
 * - entries.count (direct update if subscription found in cache)
 *
 * @param utils - tRPC utils for cache access
 * @param subscriptionId - ID of the deleted subscription
 * @param queryClient - React Query client for targeted invalidations
 */
export function handleSubscriptionDeleted(
  utils: TRPCClientUtils,
  subscriptionId: string,
  queryClient?: QueryClient
): void {
  // Look up subscription data before removing from cache
  // This lets us do targeted updates instead of broad invalidations
  const subscription = queryClient
    ? findCachedSubscription(utils, queryClient, subscriptionId)
    : undefined;

  // Remove from all subscription caches
  removeSubscriptionFromCache(utils, subscriptionId);
  if (queryClient) {
    removeSubscriptionFromInfiniteQueries(queryClient, subscriptionId);
  }

  if (subscription && queryClient) {
    // Targeted invalidations using subscription data
    invalidateSubscriptionListsForTags(
      queryClient,
      subscription.tags.map((t) => t.id),
      subscription.tags.length === 0
    );

    // Directly update tags.list feedCount and unreadCount
    utils.tags.list.setData(undefined, (oldData) => {
      if (!oldData) return oldData;

      if (subscription.tags.length === 0) {
        // Uncategorized subscription
        return {
          ...oldData,
          uncategorized: {
            feedCount: Math.max(0, oldData.uncategorized.feedCount - 1),
            unreadCount: Math.max(0, oldData.uncategorized.unreadCount - subscription.unreadCount),
          },
        };
      }

      // Update feedCount and unreadCount for each tag
      const tagIds = new Set(subscription.tags.map((t) => t.id));
      return {
        ...oldData,
        items: oldData.items.map((tag) => {
          if (tagIds.has(tag.id)) {
            return {
              ...tag,
              feedCount: Math.max(0, tag.feedCount - 1),
              unreadCount: Math.max(0, tag.unreadCount - subscription.unreadCount),
            };
          }
          return tag;
        }),
      };
    });

    // Directly update entries.count for All Articles
    adjustEntriesCount(utils, {}, -subscription.unreadCount, -subscription.unreadCount);
  } else {
    // Fallback: invalidate broadly when we don't have subscription data
    utils.subscriptions.list.invalidate();
    utils.tags.list.invalidate();
    utils.entries.count.invalidate();
  }

  // Always invalidate entries.list - entries from this subscription should be filtered out
  utils.entries.list.invalidate();
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
  subscriptionId: string | null,
  feedType: "web" | "email" | "saved",
  queryClient?: QueryClient
): void {
  // Update subscription and tag unread counts (only for non-saved entries)
  if (subscriptionId) {
    // New entries are always unread (read: false, starred: false)
    const subscriptionDeltas = new Map<string, number>();
    subscriptionDeltas.set(subscriptionId, 1); // +1 unread

    // Update subscription and tag unread counts (including per-tag infinite queries)
    updateSubscriptionAndTagCounts(utils, subscriptionDeltas, queryClient);
  }

  // Update All Articles unread count (+1 unread, +1 total)
  adjustEntriesCount(utils, {}, 1, 1);

  // Update saved unread count if it's a saved entry
  if (feedType === "saved") {
    adjustEntriesCount(utils, { type: "saved" }, 1, 1);
  }
}

// ============================================================================
// Absolute Count Updates (Server-Provided Counts)
// ============================================================================

/**
 * Unread counts for a single entry, as returned by star/unstar mutations.
 */
export interface UnreadCounts {
  all: { total: number; unread: number };
  starred: { total: number; unread: number };
  saved?: { total: number; unread: number };
  subscription?: { id: string; unread: number };
  tags?: Array<{ id: string; unread: number }>;
  uncategorized?: { unread: number };
}

/**
 * Bulk unread counts, as returned by markRead mutation.
 */
export interface BulkUnreadCounts {
  all: { total: number; unread: number };
  starred: { total: number; unread: number };
  saved: { total: number; unread: number };
  subscriptions: Array<{ id: string; unread: number }>;
  tags: Array<{ id: string; unread: number }>;
  uncategorized?: { unread: number };
}

/**
 * Sets absolute counts from server response.
 * Used by single-entry mutations (star, unstar) that return UnreadCounts.
 *
 * @param utils - tRPC utils for cache access
 * @param counts - Absolute counts from server
 * @param queryClient - React Query client for updating infinite query caches
 */
export function setCounts(
  utils: TRPCClientUtils,
  counts: UnreadCounts,
  queryClient?: QueryClient
): void {
  // Set global counts
  utils.entries.count.setData({}, counts.all);
  utils.entries.count.setData({ starredOnly: true }, counts.starred);

  if (counts.saved) {
    utils.entries.count.setData({ type: "saved" }, counts.saved);
  }

  // Set subscription unread count
  if (counts.subscription) {
    setSubscriptionUnreadCount(
      utils,
      counts.subscription.id,
      counts.subscription.unread,
      queryClient
    );
  }

  // Set tag unread counts
  if (counts.tags) {
    for (const tag of counts.tags) {
      setTagUnreadCount(utils, tag.id, tag.unread);
    }
  }

  // Set uncategorized count
  if (counts.uncategorized) {
    setUncategorizedUnreadCount(utils, counts.uncategorized.unread);
  }
}

/**
 * Sets absolute counts from bulk mutation response.
 * Used by markRead mutation that returns BulkUnreadCounts.
 *
 * @param utils - tRPC utils for cache access
 * @param counts - Absolute counts from server
 * @param queryClient - React Query client for updating infinite query caches
 */
export function setBulkCounts(
  utils: TRPCClientUtils,
  counts: BulkUnreadCounts,
  queryClient?: QueryClient
): void {
  // Set global counts
  utils.entries.count.setData({}, counts.all);
  utils.entries.count.setData({ starredOnly: true }, counts.starred);
  utils.entries.count.setData({ type: "saved" }, counts.saved);

  // Build subscription updates map for efficient batch update
  const subscriptionUpdates = new Map(counts.subscriptions.map((s) => [s.id, s.unread]));

  // Build set of affected tag IDs to only update those caches
  const affectedTagIds = new Set(counts.tags.map((t) => t.id));

  // Batch update all subscription unread counts
  setBulkSubscriptionUnreadCounts(
    utils,
    subscriptionUpdates,
    affectedTagIds,
    counts.uncategorized !== undefined,
    queryClient
  );

  // Set tag unread counts
  for (const tag of counts.tags) {
    setTagUnreadCount(utils, tag.id, tag.unread);
  }

  // Set uncategorized count
  if (counts.uncategorized) {
    setUncategorizedUnreadCount(utils, counts.uncategorized.unread);
  }
}

/**
 * Sets unread counts for multiple subscriptions, only updating affected tag caches.
 *
 * Instead of scanning ALL cached tag queries for each subscription, this function
 * uses the known affected tag IDs to only iterate through relevant caches.
 *
 * @param utils - tRPC utils for cache access
 * @param subscriptionUpdates - Map of subscriptionId -> new unread count
 * @param affectedTagIds - Set of tag IDs that were affected (only these caches need updating)
 * @param hasUncategorized - Whether uncategorized subscriptions were affected
 * @param queryClient - React Query client for updating infinite query caches
 */
function setBulkSubscriptionUnreadCounts(
  utils: TRPCClientUtils,
  subscriptionUpdates: Map<string, number>,
  affectedTagIds: Set<string>,
  hasUncategorized: boolean,
  queryClient?: QueryClient
): void {
  if (subscriptionUpdates.size === 0) return;

  // Update in unparameterized subscriptions.list cache
  utils.subscriptions.list.setData(undefined, (oldData) => {
    if (!oldData) return oldData;
    return {
      ...oldData,
      items: oldData.items.map((sub) => {
        const newUnread = subscriptionUpdates.get(sub.id);
        return newUnread !== undefined ? { ...sub, unreadCount: newUnread } : sub;
      }),
    };
  });

  // Update only the affected per-tag infinite query caches
  if (queryClient) {
    const infiniteQueries = queryClient.getQueriesData<{
      pages: Array<{ items: Array<{ id: string; unreadCount: number; [key: string]: unknown }> }>;
      pageParams: unknown[];
    }>({
      queryKey: [["subscriptions", "list"]],
    });

    for (const [queryKey, data] of infiniteQueries) {
      if (!data?.pages) continue;

      // Check if this query is for an affected tag
      const keyData = queryKey[1] as { input?: SubscriptionListInput } | undefined;
      const input = keyData?.input;

      // Skip queries that aren't for affected tags or uncategorized
      if (input) {
        const isAffectedTag = input.tagId && affectedTagIds.has(input.tagId);
        const isAffectedUncategorized = hasUncategorized && input.uncategorized === true;
        if (!isAffectedTag && !isAffectedUncategorized) {
          continue;
        }
      }

      // Update subscriptions in this cache
      queryClient.setQueryData(queryKey, {
        ...data,
        pages: data.pages.map((page) => ({
          ...page,
          items: page.items.map((s) => {
            const newUnread = subscriptionUpdates.get(s.id);
            return newUnread !== undefined ? { ...s, unreadCount: newUnread } : s;
          }),
        })),
      });
    }
  }
}

/**
 * Sets the unread count for a specific subscription.
 * Used by single-entry mutations (setCounts) where we don't know the affected tags.
 */
function setSubscriptionUnreadCount(
  utils: TRPCClientUtils,
  subscriptionId: string,
  unread: number,
  queryClient?: QueryClient
): void {
  // Update in unparameterized subscriptions.list cache
  utils.subscriptions.list.setData(undefined, (oldData) => {
    if (!oldData) return oldData;
    return {
      ...oldData,
      items: oldData.items.map((sub) =>
        sub.id === subscriptionId ? { ...sub, unreadCount: unread } : sub
      ),
    };
  });

  // Update in per-tag infinite query caches
  // Note: For single-entry mutations, we still need to scan all caches
  // since we don't have the affected tag IDs. This is acceptable because
  // single-entry mutations (star/unstar) are less frequent than markRead.
  if (queryClient) {
    const infiniteQueries = queryClient.getQueriesData<{
      pages: Array<{ items: Array<{ id: string; unreadCount: number; [key: string]: unknown }> }>;
      pageParams: unknown[];
    }>({
      queryKey: [["subscriptions", "list"]],
    });

    for (const [queryKey, data] of infiniteQueries) {
      if (!data?.pages) continue;

      const hasSubscription = data.pages.some((page) =>
        page.items.some((s) => s.id === subscriptionId)
      );

      if (hasSubscription) {
        queryClient.setQueryData(queryKey, {
          ...data,
          pages: data.pages.map((page) => ({
            ...page,
            items: page.items.map((s) =>
              s.id === subscriptionId ? { ...s, unreadCount: unread } : s
            ),
          })),
        });
      }
    }
  }
}

/**
 * Sets the unread count for a specific tag.
 */
function setTagUnreadCount(utils: TRPCClientUtils, tagId: string, unread: number): void {
  utils.tags.list.setData(undefined, (oldData) => {
    if (!oldData) return oldData;
    return {
      ...oldData,
      items: oldData.items.map((tag) => (tag.id === tagId ? { ...tag, unreadCount: unread } : tag)),
    };
  });
}

/**
 * Sets the uncategorized unread count.
 */
function setUncategorizedUnreadCount(utils: TRPCClientUtils, unread: number): void {
  utils.tags.list.setData(undefined, (oldData) => {
    if (!oldData) return oldData;
    return {
      ...oldData,
      uncategorized: {
        ...oldData.uncategorized,
        unreadCount: unread,
      },
    };
  });
}

// ============================================================================
// Optimistic Update Helpers
// ============================================================================

/**
 * Context returned by optimistic read update for rollback.
 */
export interface OptimisticReadContext {
  previousEntries: Map<string, { read: boolean } | undefined>;
  entryIds: string[];
}

/**
 * Prepares and applies an optimistic read status update.
 * Should be called in onMutate. Returns context needed for rollback in onError.
 *
 * @param utils - tRPC utils for cache access
 * @param queryClient - React Query client for cache access
 * @param entryIds - Entry IDs to update
 * @param read - New read status
 * @returns Context for rollback
 */
export async function applyOptimisticReadUpdate(
  utils: TRPCClientUtils,
  queryClient: QueryClient,
  entryIds: string[],
  read: boolean
): Promise<OptimisticReadContext> {
  // We intentionally don't cancel any queries here.
  // - Cancelling entries.get would abort content fetches, leaving only placeholder data
  // - Cancelling entries.list would disrupt scrolling/loading while marking entries read
  // - If a fetch completes with stale read status, onSuccess will correct it immediately
  // - The race condition window is small (between onMutate and onSuccess)

  // Snapshot the previous state for rollback
  const previousEntries = new Map<string, { read: boolean } | undefined>();
  for (const entryId of entryIds) {
    const data = utils.entries.get.getData({ id: entryId });
    previousEntries.set(entryId, data?.entry ? { read: data.entry.read } : undefined);
  }

  // Optimistically update the cache immediately
  updateEntriesReadStatus(utils, entryIds, read, queryClient);

  return { previousEntries, entryIds };
}

/**
 * Rolls back an optimistic read update.
 * Should be called in onError with the context from applyOptimisticReadUpdate.
 *
 * @param utils - tRPC utils for cache access
 * @param queryClient - React Query client for cache access
 * @param context - Context from applyOptimisticReadUpdate
 */
export function rollbackOptimisticReadUpdate(
  utils: TRPCClientUtils,
  queryClient: QueryClient,
  context: OptimisticReadContext
): void {
  for (const [entryId, prevState] of context.previousEntries) {
    if (prevState !== undefined) {
      updateEntriesReadStatus(utils, [entryId], prevState.read, queryClient);
    }
  }
}

/**
 * Context returned by optimistic starred update for rollback.
 */
export interface OptimisticStarredContext {
  entryId: string;
  wasStarred: boolean;
}

/**
 * Prepares and applies an optimistic starred status update.
 * Should be called in onMutate. Returns context needed for rollback in onError.
 *
 * @param utils - tRPC utils for cache access
 * @param queryClient - React Query client for cache access
 * @param entryId - Entry ID to update
 * @param starred - New starred status
 * @returns Context for rollback
 */
export async function applyOptimisticStarredUpdate(
  utils: TRPCClientUtils,
  queryClient: QueryClient,
  entryId: string,
  starred: boolean
): Promise<OptimisticStarredContext> {
  // We intentionally don't cancel any queries here.
  // - Cancelling entries.get would abort content fetches, leaving only placeholder data
  // - Cancelling entries.list would disrupt scrolling/loading
  // - If a fetch completes with stale starred status, onSuccess will correct it immediately

  // Snapshot previous state for rollback
  const previousEntry = utils.entries.get.getData({ id: entryId });
  const wasStarred = previousEntry?.entry?.starred ?? !starred;

  // Optimistically update the cache
  updateEntryStarredStatus(utils, entryId, starred, queryClient);

  return { entryId, wasStarred };
}

/**
 * Rolls back an optimistic starred update.
 * Should be called in onError with the context from applyOptimisticStarredUpdate.
 *
 * @param utils - tRPC utils for cache access
 * @param queryClient - React Query client for cache access
 * @param context - Context from applyOptimisticStarredUpdate
 */
export function rollbackOptimisticStarredUpdate(
  utils: TRPCClientUtils,
  queryClient: QueryClient,
  context: OptimisticStarredContext
): void {
  updateEntryStarredStatus(utils, context.entryId, context.wasStarred, queryClient);
}

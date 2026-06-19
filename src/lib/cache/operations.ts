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
import { updateEntriesReadStatus, updateEntryStarredStatus } from "./entry-cache";
import {
  adjustEntriesCount,
  addSubscriptionToCache,
  removeSubscriptionFromCache,
  findCachedSubscription,
  getSubscriptionLookupMap,
  setSubscriptionUnreadCountInMap,
} from "./count-cache";

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
// Private Helpers
// ============================================================================

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

    // Skip queries without input (no unparameterized query to invalidate)
    if (!input) continue;

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
  // Guard against duplicate subscription events (e.g. from sync polling).
  // Check if the subscription already exists before incrementing counts
  // to prevent unbounded count inflation (#680).
  const alreadyExists = queryClient
    ? findCachedSubscription(queryClient, subscription.id) !== undefined
    : getSubscriptionLookupMap().has(subscription.id);

  addSubscriptionToCache(subscription);

  // Skip count updates if the subscription was already in the cache
  if (alreadyExists) return;

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
  adjustEntriesCount(utils, {}, subscription.unreadCount);
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
    ? findCachedSubscription(queryClient, subscriptionId)
    : undefined;

  // Remove from all subscription caches
  removeSubscriptionFromCache(subscriptionId);
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
    adjustEntriesCount(utils, {}, -subscription.unreadCount);
  } else {
    // Fallback: invalidate broadly when we don't have subscription data
    utils.subscriptions.list.invalidate();
    utils.tags.list.invalidate();
    utils.entries.count.invalidate();
  }

  // Always invalidate entries.list - entries from this subscription should be filtered out
  utils.entries.list.invalidate();
}

// ============================================================================
// Absolute Count Updates (Server-Provided Counts)
// ============================================================================

/**
 * Unread counts for a single entry, as returned by star/unstar mutations.
 */
export interface UnreadCounts {
  all: { unread: number };
  starred: { unread: number };
  saved?: { unread: number };
  subscription?: { id: string; unread: number };
  tags?: Array<{ id: string; unread: number }>;
  uncategorized?: { unread: number };
}

/**
 * Bulk unread counts, as returned by markRead mutation.
 */
export interface BulkUnreadCounts {
  all: { unread: number };
  starred: { unread: number };
  saved: { unread: number };
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
    setSubscriptionUnreadCount(counts.subscription.id, counts.subscription.unread, queryClient);
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
 * Counts carried by count-bearing realtime events (new_entry,
 * entry_state_changed). Same shape as BulkUnreadCounts but `saved` is optional,
 * since web/email events don't compute the saved count.
 */
export type EntryRelatedCounts = Omit<BulkUnreadCounts, "saved"> & {
  saved?: { unread: number };
};

/**
 * Applies absolute unread counts from a count-bearing realtime event.
 *
 * Fills in `saved` from the current cache when the event omits it (web/email
 * events don't compute the saved count) so setBulkCounts doesn't clobber the
 * client's existing saved count with a wrong value. Because every value is set
 * absolutely, applying the same event twice — e.g. once from the live SSE
 * stream and once from a reconnect catch-up sync — leaves counts correct.
 *
 * @param utils - tRPC utils for cache access
 * @param counts - Absolute counts from the server (saved optional)
 * @param queryClient - React Query client for updating infinite query caches
 */
export function setEntryRelatedCounts(
  utils: TRPCClientUtils,
  counts: EntryRelatedCounts,
  queryClient?: QueryClient
): void {
  const currentSaved = utils.entries.count.getData({ type: "saved" });
  setBulkCounts(
    utils,
    { ...counts, saved: counts.saved ?? currentSaved ?? { unread: 0 } },
    queryClient
  );
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
  subscriptionUpdates: Map<string, number>,
  affectedTagIds: Set<string>,
  hasUncategorized: boolean,
  queryClient?: QueryClient
): void {
  if (subscriptionUpdates.size === 0) return;

  // Update the subscription lookup map
  for (const [subId, newUnread] of subscriptionUpdates) {
    setSubscriptionUnreadCountInMap(subId, newUnread);
  }

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
  subscriptionId: string,
  unread: number,
  queryClient?: QueryClient
): void {
  // Update the subscription lookup map
  setSubscriptionUnreadCountInMap(subscriptionId, unread);

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

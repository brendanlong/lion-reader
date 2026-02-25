/**
 * Count Cache Helpers
 *
 * Functions for updating unread counts on subscriptions and tags.
 * These work with the subscriptions.list and tags.list caches.
 */

import type { QueryClient } from "@tanstack/react-query";
import type { TRPCClientUtils } from "@/lib/trpc/client";

/**
 * Full subscription type as returned by subscriptions.list/get.
 * Inferred from the tRPC client utils to stay in sync with the router schema.
 */
export type CachedSubscription = NonNullable<
  ReturnType<TRPCClientUtils["subscriptions"]["list"]["getData"]>
>["items"][number];

/**
 * Fallback map for subscriptions received via SSE events that may not be in
 * any React Query cache. This handles the case where a subscription_created
 * event arrives but the subscription's query cache hasn't been populated yet
 * (e.g., the Uncategorized section is collapsed in the sidebar, so the
 * per-tag infinite query hasn't been fetched). Without this, subsequent
 * new_entry events can't determine the subscription's tags, causing
 * tag/uncategorized unread counts to not update.
 *
 * Populated by addSubscriptionToCache, cleaned by removeSubscriptionFromCache.
 */
const sseSubscriptionFallback = new Map<string, CachedSubscription>();

/**
 * Page structure in subscription infinite query cache.
 */
interface CachedSubscriptionPage {
  items: CachedSubscription[];
  nextCursor?: string;
}

/**
 * Regular query data structure for subscriptions.
 */
interface SubscriptionListData {
  items: CachedSubscription[];
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
 * Applies subscription unread count deltas to a list of subscriptions.
 */
function applySubscriptionDeltas<T extends CachedSubscription>(
  items: T[],
  subscriptionDeltas: Map<string, number>
): T[] {
  return items.map((sub) => {
    const delta = subscriptionDeltas.get(sub.id);
    if (delta !== undefined) {
      return {
        ...sub,
        unreadCount: Math.max(0, sub.unreadCount + delta),
      };
    }
    return sub;
  });
}

/**
 * Collects all cached subscriptions from both the unparameterized query
 * and all per-tag infinite queries into a single map.
 *
 * Subscriptions may only exist in one cache or the other depending on
 * which views have been loaded (entry view vs sidebar tag views).
 */
function getAllCachedSubscriptions(
  utils: TRPCClientUtils,
  queryClient?: QueryClient
): Map<string, CachedSubscription> {
  const subscriptionMap = new Map<string, CachedSubscription>();

  // Check the unparameterized query (used by UnifiedEntriesContent/EntryContent)
  const subscriptionsData = utils.subscriptions.list.getData();
  if (subscriptionsData) {
    for (const s of subscriptionsData.items) {
      subscriptionMap.set(s.id, s);
    }
  }

  // Check per-tag infinite queries (used by TagSubscriptionList in sidebar)
  if (queryClient) {
    forEachCachedSubscription(queryClient, (s) => {
      if (!subscriptionMap.has(s.id)) {
        subscriptionMap.set(s.id, s);
      }
    });
  }

  // Fallback: check SSE subscription map for subscriptions not in any query cache.
  // This covers newly-created subscriptions whose query caches haven't been populated
  // (e.g., Uncategorized section is collapsed so the infinite query was never fetched).
  for (const [id, s] of sseSubscriptionFallback) {
    if (!subscriptionMap.has(id)) {
      subscriptionMap.set(id, s);
    }
  }

  return subscriptionMap;
}

/**
 * Iterates over all subscriptions in cached subscription list queries.
 * Handles both regular queries and infinite queries (used by sidebar).
 */
function forEachCachedSubscription(
  queryClient: QueryClient,
  callback: (subscription: CachedSubscription) => void
): void {
  const queries = queryClient.getQueriesData<SubscriptionListData | SubscriptionInfiniteData>({
    queryKey: [["subscriptions", "list"]],
  });
  for (const [, data] of queries) {
    if (!data) continue;

    // Check if it's infinite query format (has pages array)
    if ("pages" in data && Array.isArray(data.pages)) {
      for (const page of data.pages) {
        if (page?.items) {
          for (const s of page.items) {
            callback(s);
          }
        }
      }
    }
    // Regular query format (has items directly)
    else if ("items" in data && Array.isArray(data.items)) {
      for (const s of data.items) {
        callback(s);
      }
    }
  }
}

/**
 * Finds a single subscription by ID across all subscription caches.
 *
 * Checks both the unparameterized subscriptions.list query (populated by entry pages)
 * and per-tag infinite queries (populated by sidebar tag sections).
 *
 * Useful for providing placeholder data when navigating to a subscription page,
 * since the subscription may be cached from the sidebar but not from the entry page query.
 */
export function findCachedSubscription(
  utils: TRPCClientUtils,
  queryClient: QueryClient,
  subscriptionId: string
): CachedSubscription | undefined {
  // Check the unparameterized query first (cheaper lookup)
  const listData = utils.subscriptions.list.getData();
  if (listData) {
    const found = listData.items.find((s) => s.id === subscriptionId);
    if (found) return found;
  }

  // Check per-tag infinite queries
  let found: CachedSubscription | undefined;
  forEachCachedSubscription(queryClient, (s) => {
    if (!found && s.id === subscriptionId) {
      found = s;
    }
  });
  if (found) return found;

  // Fallback: check SSE subscription map
  return sseSubscriptionFallback.get(subscriptionId);
}

/**
 * Adjusts unread counts for subscriptions in the cache.
 * Updates both the unparameterized query (used by UnifiedEntriesContent/EntryContent)
 * and all per-tag infinite queries (used by TagSubscriptionList in sidebar).
 *
 * @param utils - tRPC utils for cache access
 * @param subscriptionDeltas - Map of subscriptionId -> count change (+1 for unread, -1 for read)
 * @param queryClient - React Query client for updating infinite query caches
 */
export function adjustSubscriptionUnreadCounts(
  utils: TRPCClientUtils,
  subscriptionDeltas: Map<string, number>,
  queryClient?: QueryClient
): void {
  if (subscriptionDeltas.size === 0) return;

  // Update the unparameterized query (used by UnifiedEntriesContent/EntryContent)
  utils.subscriptions.list.setData(undefined, (oldData) => {
    if (!oldData) return oldData;

    return {
      ...oldData,
      items: applySubscriptionDeltas(oldData.items, subscriptionDeltas),
    };
  });

  // Update all per-tag infinite queries (used by TagSubscriptionList in sidebar)
  // These have query keys like [["subscriptions", "list"], { input: {...}, type: "infinite" }]
  if (queryClient) {
    const infiniteQueries = queryClient.getQueriesData<SubscriptionInfiniteData>({
      queryKey: [["subscriptions", "list"]],
    });
    for (const [queryKey, data] of infiniteQueries) {
      // Only update infinite queries (they have pages array)
      if (!data?.pages) continue;
      queryClient.setQueryData<SubscriptionInfiniteData>(queryKey, {
        ...data,
        pages: data.pages.map((page) => ({
          ...page,
          items: applySubscriptionDeltas(page.items, subscriptionDeltas),
        })),
      });
    }
  }
}

/**
 * Adjusts unread counts for tags in the cache, including the uncategorized section.
 *
 * @param utils - tRPC utils for cache access
 * @param tagDeltas - Map of tagId -> count change (+1 for unread, -1 for read)
 * @param uncategorizedDelta - Count change for uncategorized subscriptions
 */
export function adjustTagUnreadCounts(
  utils: TRPCClientUtils,
  tagDeltas: Map<string, number>,
  uncategorizedDelta: number = 0
): void {
  if (tagDeltas.size === 0 && uncategorizedDelta === 0) return;

  utils.tags.list.setData(undefined, (oldData) => {
    if (!oldData) return oldData;

    return {
      ...oldData,
      items: oldData.items.map((tag) => {
        const delta = tagDeltas.get(tag.id);
        if (delta !== undefined) {
          return {
            ...tag,
            unreadCount: Math.max(0, tag.unreadCount + delta),
          };
        }
        return tag;
      }),
      uncategorized:
        uncategorizedDelta !== 0
          ? {
              ...oldData.uncategorized,
              unreadCount: Math.max(0, oldData.uncategorized.unreadCount + uncategorizedDelta),
            }
          : oldData.uncategorized,
    };
  });
}

/**
 * Adjusts the entries.count cache values.
 *
 * @param utils - tRPC utils for cache access
 * @param filters - The filter params to target (e.g., { starredOnly: true })
 * @param unreadDelta - Change to unread count
 */
export function adjustEntriesCount(
  utils: TRPCClientUtils,
  filters: Parameters<typeof utils.entries.count.setData>[0],
  unreadDelta: number
): void {
  utils.entries.count.setData(filters, (oldData) => {
    if (!oldData) return oldData;
    return {
      unread: Math.max(0, oldData.unread + unreadDelta),
    };
  });
}

/**
 * Adds a new subscription to the subscriptions.list cache.
 * Used when subscription_created SSE event arrives.
 *
 * @param utils - tRPC utils for cache access
 * @param subscription - The new subscription to add
 */
export function addSubscriptionToCache(
  utils: TRPCClientUtils,
  subscription: CachedSubscription & {
    type: "web" | "email" | "saved";
    url: string | null;
    title: string | null;
    originalTitle: string | null;
    description: string | null;
    siteUrl: string | null;
    subscribedAt: Date;
    fetchFullContent: boolean;
  }
): void {
  // Store in SSE fallback map so tag delta calculations can find this
  // subscription even if no query cache has been populated for it yet.
  sseSubscriptionFallback.set(subscription.id, subscription);

  utils.subscriptions.list.setData(undefined, (oldData) => {
    if (!oldData) return oldData;

    // Check for duplicates (SSE race condition)
    if (oldData.items.some((s) => s.id === subscription.id)) {
      return oldData;
    }

    return {
      ...oldData,
      items: [...oldData.items, subscription],
    };
  });
}

/**
 * Updates a subscription's properties in the unparameterized subscriptions.list cache
 * and the SSE fallback map.
 *
 * @param utils - tRPC utils for cache access
 * @param subscriptionId - ID of the subscription to update
 * @param updates - Properties to update on the subscription
 */
export function updateSubscriptionInCache(
  utils: TRPCClientUtils,
  subscriptionId: string,
  updates: Partial<Pick<CachedSubscription, "tags" | "title">>
): void {
  // Update in SSE fallback map
  const fallback = sseSubscriptionFallback.get(subscriptionId);
  if (fallback) {
    sseSubscriptionFallback.set(subscriptionId, { ...fallback, ...updates });
  }

  // Update in unparameterized subscriptions.list cache
  utils.subscriptions.list.setData(undefined, (oldData) => {
    if (!oldData) return oldData;
    return {
      ...oldData,
      items: oldData.items.map((s) => (s.id === subscriptionId ? { ...s, ...updates } : s)),
    };
  });

  // Update in subscriptions.get cache (used by entry list title)
  utils.subscriptions.get.setData({ id: subscriptionId }, (oldData) => {
    if (!oldData) return oldData;
    return { ...oldData, ...updates };
  });
}

/**
 * Removes a subscription from the subscriptions.list cache.
 * Used for optimistic updates when unsubscribing.
 *
 * @param utils - tRPC utils for cache access
 * @param subscriptionId - ID of the subscription to remove
 */
export function removeSubscriptionFromCache(utils: TRPCClientUtils, subscriptionId: string): void {
  sseSubscriptionFallback.delete(subscriptionId);

  utils.subscriptions.list.setData(undefined, (oldData) => {
    if (!oldData) return oldData;
    return {
      ...oldData,
      items: oldData.items.filter((s) => s.id !== subscriptionId),
    };
  });
}

/**
 * Result of calculating tag deltas from subscription deltas.
 */
export interface TagDeltaResult {
  tagDeltas: Map<string, number>;
  uncategorizedDelta: number;
}

/**
 * Calculates tag deltas from subscription deltas.
 * Uses the cached subscription data to look up which tags each subscription has.
 * Also calculates the delta for uncategorized subscriptions (those with no tags).
 *
 * @param utils - tRPC utils for cache access
 * @param subscriptionDeltas - Map of subscriptionId -> count change
 * @param queryClient - React Query client for searching infinite query caches
 * @returns Tag deltas and uncategorized delta
 */
export function calculateTagDeltasFromSubscriptions(
  utils: TRPCClientUtils,
  subscriptionDeltas: Map<string, number>,
  queryClient?: QueryClient
): TagDeltaResult {
  const tagDeltas = new Map<string, number>();
  let uncategorizedDelta = 0;

  const subscriptionMap = getAllCachedSubscriptions(utils, queryClient);
  if (subscriptionMap.size === 0) return { tagDeltas, uncategorizedDelta };

  // Calculate tag deltas and uncategorized delta
  for (const [subscriptionId, delta] of subscriptionDeltas) {
    const subscription = subscriptionMap.get(subscriptionId);
    if (subscription) {
      if (subscription.tags.length === 0) {
        uncategorizedDelta += delta;
      } else {
        for (const tag of subscription.tags) {
          const currentDelta = tagDeltas.get(tag.id) ?? 0;
          tagDeltas.set(tag.id, currentDelta + delta);
        }
      }
    }
  }

  return { tagDeltas, uncategorizedDelta };
}

// ============================================================================
// Tag Cache Direct Updates (for sync)
// ============================================================================

/**
 * Tag data for sync operations.
 */
export interface SyncTag {
  id: string;
  name: string;
  color: string | null;
}

/**
 * Updates or adds tags in the tags.list cache based on sync data.
 * Does not invalidate - directly applies changes.
 *
 * @param utils - tRPC utils for cache access
 * @param createdTags - Tags that are newly created
 * @param updatedTags - Tags that have been updated
 */
export function applySyncTagChanges(
  utils: TRPCClientUtils,
  createdTags: SyncTag[],
  updatedTags: SyncTag[]
): void {
  if (createdTags.length === 0 && updatedTags.length === 0) return;

  utils.tags.list.setData(undefined, (oldData) => {
    if (!oldData) return oldData;

    // Create a map for efficient lookups
    const updatedTagsMap = new Map(updatedTags.map((t) => [t.id, t]));

    // Update existing tags
    let items = oldData.items.map((tag) => {
      const update = updatedTagsMap.get(tag.id);
      if (update) {
        return {
          ...tag,
          name: update.name,
          color: update.color,
        };
      }
      return tag;
    });

    // Add newly created tags (with default counts)
    for (const newTag of createdTags) {
      // Check for duplicates (race condition)
      if (!items.some((t) => t.id === newTag.id)) {
        items.push({
          id: newTag.id,
          name: newTag.name,
          color: newTag.color,
          feedCount: 0,
          unreadCount: 0,
          createdAt: new Date(), // Approximate, doesn't need to be exact
        });
      }
    }

    // Sort by name (matching server behavior)
    items = items.sort((a, b) => a.name.localeCompare(b.name));

    return {
      ...oldData,
      items,
    };
  });
}

/**
 * Removes tags from the tags.list cache based on sync data.
 * Does not invalidate - directly removes from cache.
 *
 * @param utils - tRPC utils for cache access
 * @param removedTagIds - IDs of tags to remove
 */
export function removeSyncTags(utils: TRPCClientUtils, removedTagIds: string[]): void {
  if (removedTagIds.length === 0) return;

  const removedSet = new Set(removedTagIds);

  utils.tags.list.setData(undefined, (oldData) => {
    if (!oldData) return oldData;

    return {
      ...oldData,
      items: oldData.items.filter((tag) => !removedSet.has(tag.id)),
    };
  });
}

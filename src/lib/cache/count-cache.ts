/**
 * Count Cache Helpers
 *
 * Functions for updating unread counts on subscriptions and tags.
 * These work with the subscriptions.list and tags.list caches.
 */

import type { QueryClient } from "@tanstack/react-query";
import type { TRPCClientUtils } from "@/lib/trpc/client";

/**
 * Subscription data from the cache.
 */
interface CachedSubscription {
  id: string;
  unreadCount: number;
  tags: Array<{ id: string; name: string; color: string | null }>;
}

/**
 * Page structure in subscription infinite query cache.
 */
interface CachedSubscriptionPage {
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
function applySubscriptionDeltas(
  items: CachedSubscription[],
  subscriptionDeltas: Map<string, number>
): CachedSubscription[] {
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
 * Adjusts unread counts for subscriptions in the cache.
 * Updates both the unparameterized query (used by useEntryPage/EntryContent)
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

  // Update the unparameterized query (used by useEntryPage/EntryContent)
  utils.subscriptions.list.setData(undefined, (oldData) => {
    if (!oldData) return oldData;

    return {
      ...oldData,
      items: oldData.items.map((sub) => {
        const delta = subscriptionDeltas.get(sub.id);
        if (delta !== undefined) {
          return {
            ...sub,
            unreadCount: Math.max(0, sub.unreadCount + delta),
          };
        }
        return sub;
      }),
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
 * @param totalDelta - Change to total count (default: 0)
 */
export function adjustEntriesCount(
  utils: TRPCClientUtils,
  filters: Parameters<typeof utils.entries.count.setData>[0],
  unreadDelta: number,
  totalDelta: number = 0
): void {
  utils.entries.count.setData(filters, (oldData) => {
    if (!oldData) return oldData;
    return {
      total: Math.max(0, oldData.total + totalDelta),
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
 * Removes a subscription from the subscriptions.list cache.
 * Used for optimistic updates when unsubscribing.
 *
 * @param utils - tRPC utils for cache access
 * @param subscriptionId - ID of the subscription to remove
 */
export function removeSubscriptionFromCache(utils: TRPCClientUtils, subscriptionId: string): void {
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
 * @returns Tag deltas and uncategorized delta
 */
export function calculateTagDeltasFromSubscriptions(
  utils: TRPCClientUtils,
  subscriptionDeltas: Map<string, number>
): TagDeltaResult {
  const tagDeltas = new Map<string, number>();
  let uncategorizedDelta = 0;

  // Get subscriptions from cache to look up tags
  const subscriptionsData = utils.subscriptions.list.getData();
  if (!subscriptionsData) return { tagDeltas, uncategorizedDelta };

  // Build a map for quick lookup
  const subscriptionMap = new Map(subscriptionsData.items.map((s) => [s.id, s]));

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

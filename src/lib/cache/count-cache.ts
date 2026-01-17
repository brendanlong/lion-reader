/**
 * Count Cache Helpers
 *
 * Functions for updating unread counts on subscriptions and tags.
 * These work with the subscriptions.list and tags.list caches.
 */

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
 * Adjusts unread counts for subscriptions in the cache.
 *
 * @param utils - tRPC utils for cache access
 * @param subscriptionDeltas - Map of subscriptionId -> count change (+1 for unread, -1 for read)
 */
export function adjustSubscriptionUnreadCounts(
  utils: TRPCClientUtils,
  subscriptionDeltas: Map<string, number>
): void {
  if (subscriptionDeltas.size === 0) return;

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
}

/**
 * Adjusts unread counts for tags in the cache.
 *
 * @param utils - tRPC utils for cache access
 * @param tagDeltas - Map of tagId -> count change (+1 for unread, -1 for read)
 */
export function adjustTagUnreadCounts(
  utils: TRPCClientUtils,
  tagDeltas: Map<string, number>
): void {
  if (tagDeltas.size === 0) return;

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
 * Calculates tag deltas from subscription deltas.
 * Uses the cached subscription data to look up which tags each subscription has.
 *
 * @param utils - tRPC utils for cache access
 * @param subscriptionDeltas - Map of subscriptionId -> count change
 * @returns Map of tagId -> count change
 */
export function calculateTagDeltasFromSubscriptions(
  utils: TRPCClientUtils,
  subscriptionDeltas: Map<string, number>
): Map<string, number> {
  const tagDeltas = new Map<string, number>();

  // Get subscriptions from cache to look up tags
  const subscriptionsData = utils.subscriptions.list.getData();
  if (!subscriptionsData) return tagDeltas;

  // Build a map for quick lookup
  const subscriptionMap = new Map(subscriptionsData.items.map((s) => [s.id, s]));

  // Calculate tag deltas
  for (const [subscriptionId, delta] of subscriptionDeltas) {
    const subscription = subscriptionMap.get(subscriptionId);
    if (subscription) {
      for (const tag of subscription.tags) {
        const currentDelta = tagDeltas.get(tag.id) ?? 0;
        tagDeltas.set(tag.id, currentDelta + delta);
      }
    }
  }

  return tagDeltas;
}

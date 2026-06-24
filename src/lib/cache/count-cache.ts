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
 * Canonical subscription lookup map. This is the single source of truth for
 * subscription data used by SSE event handlers and count calculations.
 *
 * Replaces the previous two-layer approach (unparameterized React Query cache +
 * separate SSE fallback map) with a plain Map. Populated by:
 * - addSubscriptionToCache (subscription_created events, mutation side-effects)
 * - updateSubscriptionInCache (subscription_updated events)
 * - Cleaned by removeSubscriptionFromCache (subscription_deleted, unsubscribe)
 *
 * Read by findCachedSubscription() and the alreadyRemoved check in
 * event-handlers.ts.
 */
const subscriptionLookupMap = new Map<string, CachedSubscription>();

/**
 * Resets the subscription lookup map.
 * Exported for test isolation only - this map is module-level state
 * that persists across tests and must be cleared between them.
 */
export function _resetSubscriptionLookupMap(): void {
  subscriptionLookupMap.clear();
}

/**
 * Returns the subscription lookup map for direct access.
 * Used by event handlers to check subscription existence.
 */
export function getSubscriptionLookupMap(): ReadonlyMap<string, CachedSubscription> {
  return subscriptionLookupMap;
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
 * Iterates over all subscriptions in cached per-tag infinite queries (used by sidebar).
 */
function forEachCachedSubscription(
  queryClient: QueryClient,
  callback: (subscription: CachedSubscription) => void
): void {
  const queries = queryClient.getQueriesData<SubscriptionInfiniteData>({
    queryKey: [["subscriptions", "list"]],
  });
  for (const [, data] of queries) {
    if (!data?.pages) continue;
    for (const page of data.pages) {
      if (page?.items) {
        for (const s of page.items) {
          callback(s);
        }
      }
    }
  }
}

/**
 * Finds a single subscription by ID across all subscription caches.
 *
 * Checks the subscription lookup map first (O(1) lookup), then falls back
 * to per-tag infinite queries (populated by sidebar tag sections).
 *
 * Useful for providing placeholder data when navigating to a subscription page,
 * since the subscription may be cached from the sidebar but not from the lookup map.
 */
export function findCachedSubscription(
  queryClient: QueryClient,
  subscriptionId: string
): CachedSubscription | undefined {
  // Check the lookup map first (O(1) lookup)
  const fromMap = subscriptionLookupMap.get(subscriptionId);
  if (fromMap) return fromMap;

  // Check per-tag infinite queries
  let found: CachedSubscription | undefined;
  forEachCachedSubscription(queryClient, (s) => {
    if (!found && s.id === subscriptionId) {
      found = s;
    }
  });
  return found;
}

/**
 * Adds a new subscription to the subscription lookup map.
 * Used when subscription_created SSE event arrives or from mutation side-effects.
 *
 * @param subscription - The new subscription to add
 */
export function addSubscriptionToCache(
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
  subscriptionLookupMap.set(subscription.id, subscription);
}

/**
 * Updates a subscription's properties in the subscription lookup map
 * and subscriptions.get cache.
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
  // Update in subscription lookup map
  const existing = subscriptionLookupMap.get(subscriptionId);
  if (existing) {
    subscriptionLookupMap.set(subscriptionId, { ...existing, ...updates });
  }

  // Update in subscriptions.get cache (used by entry list title)
  utils.subscriptions.get.setData({ id: subscriptionId }, (oldData) => {
    if (!oldData) return oldData;
    return { ...oldData, ...updates };
  });
}

/**
 * Removes a subscription from the subscription lookup map.
 * Used for optimistic updates when unsubscribing.
 *
 * @param subscriptionId - ID of the subscription to remove
 */
export function removeSubscriptionFromCache(subscriptionId: string): void {
  subscriptionLookupMap.delete(subscriptionId);
}

/**
 * Sets the absolute unread count for a subscription in the lookup map.
 * Used by server-provided absolute count updates (markRead, star/unstar mutations).
 *
 * @param subscriptionId - ID of the subscription to update
 * @param unreadCount - New absolute unread count
 */
export function setSubscriptionUnreadCountInMap(subscriptionId: string, unreadCount: number): void {
  const sub = subscriptionLookupMap.get(subscriptionId);
  if (sub) {
    subscriptionLookupMap.set(subscriptionId, { ...sub, unreadCount: Math.max(0, unreadCount) });
  }
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

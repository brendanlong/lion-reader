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
 * Read by getAllCachedSubscriptions(), findCachedSubscription(), and the
 * alreadyRemoved check in event-handlers.ts.
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
 * Used by event handlers to check subscription existence without going
 * through the full getAllCachedSubscriptions() machinery.
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
 * Collects all cached subscriptions from the subscription lookup map
 * and per-tag infinite queries into a single map.
 *
 * The lookup map is the primary source; infinite queries provide
 * additional subscriptions that may have been loaded by the sidebar
 * but not yet seen via SSE events.
 */
function getAllCachedSubscriptions(queryClient?: QueryClient): Map<string, CachedSubscription> {
  // Start with a copy of the subscription lookup map
  const subscriptionMap = new Map<string, CachedSubscription>(subscriptionLookupMap);

  // Also check per-tag infinite queries (used by TagSubscriptionList in sidebar)
  if (queryClient) {
    forEachCachedSubscription(queryClient, (s) => {
      if (!subscriptionMap.has(s.id)) {
        subscriptionMap.set(s.id, s);
      }
    });
  }

  return subscriptionMap;
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
 * Adjusts unread counts for subscriptions in the cache.
 * Updates the subscription lookup map and all per-tag infinite queries
 * (used by TagSubscriptionList in sidebar).
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

  // Update the subscription lookup map
  for (const [subId, delta] of subscriptionDeltas) {
    const sub = subscriptionLookupMap.get(subId);
    if (sub) {
      subscriptionLookupMap.set(subId, {
        ...sub,
        unreadCount: Math.max(0, sub.unreadCount + delta),
      });
    }
  }

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

  const subscriptionMap = getAllCachedSubscriptions(queryClient);
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

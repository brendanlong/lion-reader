/**
 * Entry Cache Helpers
 *
 * Functions for updating entry state in React Query cache.
 *
 * Strategy:
 * - For individual entry views (entries.get): update directly
 * - For entry lists (entries.list): update in place without invalidation
 *   (entries stay visible until navigation; useEntryListQuery refetches on pathname change)
 * - For counts (subscriptions, tags): update directly via count-cache helpers
 */

import type { QueryClient } from "@tanstack/react-query";
import type { TRPCClientUtils } from "@/lib/trpc/client";

/**
 * Entry data in list cache.
 */
interface CachedListEntry {
  id: string;
  read: boolean;
  starred: boolean;
  [key: string]: unknown;
}

/**
 * Page structure in infinite query cache.
 */
interface CachedPage {
  items: CachedListEntry[];
  nextCursor?: string;
}

/**
 * Infinite query data structure.
 */
interface InfiniteData {
  pages: CachedPage[];
  pageParams: unknown[];
}

/**
 * Updates entries in all cached entry lists (infinite queries).
 * Uses QueryClient.setQueriesData to update all cached queries regardless of filters.
 *
 * @param queryClient - React Query client for cache access
 * @param entryIds - Entry IDs to update
 * @param updates - Fields to update (read, starred)
 */
export function updateEntriesInListCache(
  queryClient: QueryClient,
  entryIds: string[],
  updates: Partial<{ read: boolean; starred: boolean }>
): void {
  const entryIdSet = new Set(entryIds);

  // Update all cached entry list queries (matches any query starting with ['entries', 'list'])
  queryClient.setQueriesData<InfiniteData>({ queryKey: [["entries", "list"]] }, (oldData) => {
    if (!oldData?.pages) return oldData;

    return {
      ...oldData,
      pages: oldData.pages.map((page) => ({
        ...page,
        items: page.items.map((entry) => {
          if (entryIdSet.has(entry.id)) {
            return { ...entry, ...updates };
          }
          return entry;
        }),
      })),
    };
  });
}

/**
 * Updates read status for entries in caches.
 * Updates both entries.get (single entry) and entries.list (all lists) caches.
 * Does NOT invalidate/refetch - entries stay visible until navigation.
 *
 * Note: Call adjustSubscriptionUnreadCounts and adjustTagUnreadCounts separately
 * for count updates - those update directly without invalidation.
 *
 * @param utils - tRPC utils for cache access
 * @param entryIds - Entry IDs to update
 * @param read - New read status
 * @param queryClient - React Query client (optional, needed for list cache updates)
 */
export function updateEntriesReadStatus(
  utils: TRPCClientUtils,
  entryIds: string[],
  read: boolean,
  queryClient?: QueryClient
): void {
  // Update individual entries.get caches - these are keyed by entry ID
  for (const entryId of entryIds) {
    utils.entries.get.setData({ id: entryId }, (oldData) => {
      if (!oldData) return oldData;
      return {
        ...oldData,
        entry: { ...oldData.entry, read },
      };
    });
  }

  // Update entries in all cached list queries (if queryClient provided)
  if (queryClient) {
    updateEntriesInListCache(queryClient, entryIds, { read });
  }
}

/**
 * Updates starred status for an entry in caches.
 * Updates both entries.get (single entry) and entries.list (all lists) caches.
 * Does NOT invalidate/refetch - entries stay visible until navigation.
 *
 * @param utils - tRPC utils for cache access
 * @param entryId - Entry ID to update
 * @param starred - New starred status
 * @param queryClient - React Query client (optional, needed for list cache updates)
 */
export function updateEntryStarredStatus(
  utils: TRPCClientUtils,
  entryId: string,
  starred: boolean,
  queryClient?: QueryClient
): void {
  // Update entries.get cache
  utils.entries.get.setData({ id: entryId }, (oldData) => {
    if (!oldData) return oldData;
    return {
      ...oldData,
      entry: { ...oldData.entry, starred },
    };
  });

  // Update entries in all cached list queries (if queryClient provided)
  if (queryClient) {
    updateEntriesInListCache(queryClient, [entryId], { starred });
  }
}

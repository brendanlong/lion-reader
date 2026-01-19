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

/**
 * Entry data from the list (lightweight, no content).
 */
export interface EntryListItem {
  id: string;
  feedId: string;
  subscriptionId: string | null;
  type: "web" | "email" | "saved";
  url: string | null;
  title: string | null;
  author: string | null;
  summary: string | null;
  publishedAt: Date | null;
  fetchedAt: Date;
  read: boolean;
  starred: boolean;
  feedTitle: string | null;
}

/**
 * Finds an entry in the cached entry lists by ID.
 * Searches through all cached infinite query pages.
 *
 * @param queryClient - React Query client for cache access
 * @param entryId - Entry ID to find
 * @returns The entry if found, undefined otherwise
 */
export function findEntryInListCache(
  queryClient: QueryClient,
  entryId: string
): EntryListItem | undefined {
  // Get all cached entry list queries
  const queries = queryClient.getQueriesData<InfiniteData>({
    queryKey: [["entries", "list"]],
  });

  for (const [, data] of queries) {
    if (!data?.pages) continue;
    for (const page of data.pages) {
      const entry = page.items.find((e) => e.id === entryId);
      if (entry) {
        // The cache contains full EntryListItem data, but TypeScript only sees CachedListEntry
        return entry as unknown as EntryListItem;
      }
    }
  }

  return undefined;
}

/**
 * Converts a list item to the full entry response format for use as placeholder data.
 * Content fields are set to null since they're not available in list data.
 *
 * @param listItem - Entry data from the list
 * @returns Object matching the entries.get response shape
 */
export function listItemToPlaceholderEntry(listItem: EntryListItem): {
  entry: EntryListItem & {
    contentOriginal: null;
    contentCleaned: null;
    feedUrl: null;
    siteName: null;
    fullContentOriginal: null;
    fullContentCleaned: null;
    fullContentFetchedAt: null;
    fullContentError: null;
  };
} {
  return {
    entry: {
      ...listItem,
      contentOriginal: null,
      contentCleaned: null,
      feedUrl: null,
      siteName: null,
      fullContentOriginal: null,
      fullContentCleaned: null,
      fullContentFetchedAt: null,
      fullContentError: null,
    },
  };
}

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

/**
 * Filter options for entry list queries.
 */
export interface EntryListFilters {
  subscriptionId?: string;
  tagId?: string;
  uncategorized?: boolean;
  unreadOnly?: boolean;
  starredOnly?: boolean;
  sortOrder?: "newest" | "oldest";
  type?: "web" | "email" | "saved";
}

/**
 * Subscription info needed for tag filtering.
 */
interface SubscriptionInfo {
  id: string;
  tags: Array<{ id: string }>;
}

/**
 * Query key structure for tRPC infinite queries.
 * The key is [["entries", "list"], { input: {...}, type: "infinite" }]
 */
interface TRPCQueryKey {
  input?: EntryListFilters & { limit?: number; cursor?: string };
  type?: string;
}

/**
 * Checks if a parent query's filters are compatible for use as placeholder data.
 * A parent is compatible if it's a superset of the requested filters.
 *
 * @param parentFilters - Filters from the parent query
 * @param requestedFilters - Filters being requested
 * @returns true if parent can provide placeholder data for the request
 */
function areFiltersCompatible(
  parentFilters: EntryListFilters,
  requestedFilters: EntryListFilters
): boolean {
  // Sort order must match (we can't reorder entries client-side)
  const parentSort = parentFilters.sortOrder ?? "newest";
  const requestedSort = requestedFilters.sortOrder ?? "newest";
  if (parentSort !== requestedSort) return false;

  // If parent has starredOnly=true, we can only use it for starred requests
  if (parentFilters.starredOnly && !requestedFilters.starredOnly) return false;

  // If parent has unreadOnly=true, we can only use it for unread requests
  if (parentFilters.unreadOnly && !requestedFilters.unreadOnly) return false;

  // If parent has a type filter, it must match (or be omitted)
  if (parentFilters.type && parentFilters.type !== requestedFilters.type) return false;

  // If parent has subscriptionId, it must match
  if (
    parentFilters.subscriptionId &&
    parentFilters.subscriptionId !== requestedFilters.subscriptionId
  )
    return false;

  // If parent has tagId, it must match
  if (parentFilters.tagId && parentFilters.tagId !== requestedFilters.tagId) return false;

  // If parent has uncategorized, it must match
  if (parentFilters.uncategorized && !requestedFilters.uncategorized) return false;

  return true;
}

/**
 * Filters entries from a parent list to match the requested filters.
 *
 * @param entries - Entries from the parent list
 * @param filters - Requested filters to apply
 * @param subscriptions - Subscription data for tag filtering
 * @returns Filtered entries
 */
function filterEntries(
  entries: CachedListEntry[],
  filters: EntryListFilters,
  subscriptions?: SubscriptionInfo[]
): CachedListEntry[] {
  let result = entries;

  // Filter by subscriptionId
  if (filters.subscriptionId) {
    result = result.filter((e) => e.subscriptionId === filters.subscriptionId);
  }

  // Filter by tagId (need subscriptions data to know which subscriptions have this tag)
  if (filters.tagId && subscriptions) {
    const subscriptionIdsInTag = new Set(
      subscriptions
        .filter((sub) => sub.tags.some((tag) => tag.id === filters.tagId))
        .map((sub) => sub.id)
    );
    result = result.filter(
      (e) => e.subscriptionId && subscriptionIdsInTag.has(e.subscriptionId as string)
    );
  }

  // Filter by uncategorized (subscriptions with no tags)
  if (filters.uncategorized && subscriptions) {
    const uncategorizedSubscriptionIds = new Set(
      subscriptions.filter((sub) => sub.tags.length === 0).map((sub) => sub.id)
    );
    result = result.filter(
      (e) => e.subscriptionId && uncategorizedSubscriptionIds.has(e.subscriptionId as string)
    );
  }

  // Filter by starredOnly
  if (filters.starredOnly) {
    result = result.filter((e) => e.starred);
  }

  // Filter by unreadOnly
  if (filters.unreadOnly) {
    result = result.filter((e) => !e.read);
  }

  // Filter by type
  if (filters.type) {
    result = result.filter((e) => e.type === filters.type);
  }

  return result;
}

/**
 * Entry list item structure for placeholder data.
 * Matches the schema returned by entries.list tRPC procedure.
 */
interface EntryListItemForPlaceholder {
  id: string;
  subscriptionId: string | null;
  feedId: string;
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
  siteName: string | null;
}

/**
 * Page structure for typed placeholder data.
 */
interface TypedPage {
  items: EntryListItemForPlaceholder[];
  nextCursor?: string;
}

/**
 * Typed infinite data for placeholder.
 */
interface TypedInfiniteData {
  pages: TypedPage[];
  pageParams: (string | undefined)[];
}

/**
 * Finds placeholder data from a parent list cache that can be used while the actual query loads.
 * Uses hierarchical parent-child relationships:
 * - "All" list (no filters) can provide placeholders for any filtered list
 * - Tag list can provide placeholders for subscriptions within that tag
 *
 * The returned data is filtered client-side to match the requested filters.
 * Only returns data if a compatible parent list is found in the cache.
 *
 * @param queryClient - React Query client for cache access
 * @param filters - Requested filters for the entry list
 * @param subscriptions - Subscription data for tag filtering (required for tagId/uncategorized filters)
 * @returns Placeholder data in infinite query format, or undefined if no suitable parent found
 */
export function findParentListPlaceholderData(
  queryClient: QueryClient,
  filters: EntryListFilters,
  subscriptions?: SubscriptionInfo[]
): TypedInfiniteData | undefined {
  // Saved entries are a separate data source, can't use parent list
  if (filters.type === "saved") return undefined;

  // Get all cached entry list queries
  const queries = queryClient.getQueriesData<InfiniteData>({
    queryKey: [["entries", "list"]],
  });

  // Find the best parent query (prefer broader queries with more data)
  let bestParent: { data: InfiniteData; filters: EntryListFilters } | undefined;
  let bestScore = -1;

  for (const [queryKey, data] of queries) {
    if (!data?.pages?.length) continue;

    // Extract input filters from query key
    // tRPC query key is: [["entries", "list"], { input: {...}, type: "infinite" }]
    const keyMeta = queryKey[1] as TRPCQueryKey | undefined;
    const parentFilters: EntryListFilters = keyMeta?.input ?? {};

    // Check if this parent is compatible
    if (!areFiltersCompatible(parentFilters, filters)) continue;

    // Score: prefer parents with fewer filters (broader data sets)
    // and more total entries
    const filterCount =
      (parentFilters.subscriptionId ? 1 : 0) +
      (parentFilters.tagId ? 1 : 0) +
      (parentFilters.uncategorized ? 1 : 0) +
      (parentFilters.starredOnly ? 1 : 0) +
      (parentFilters.unreadOnly ? 1 : 0) +
      (parentFilters.type ? 1 : 0);

    const entryCount = data.pages.reduce((acc, page) => acc + page.items.length, 0);
    // Score: more entries is better, fewer filters is better
    const score = entryCount * 10 - filterCount * 100;

    if (score > bestScore) {
      bestScore = score;
      bestParent = { data, filters: parentFilters };
    }
  }

  if (!bestParent) return undefined;

  // Filter the parent's entries to match the requested filters
  const allEntries = bestParent.data.pages.flatMap((page) => page.items);
  const filteredEntries = filterEntries(allEntries, filters, subscriptions);

  // No matching entries found
  if (filteredEntries.length === 0) return undefined;

  // Return in infinite query format (single page, no cursor for placeholder)
  // Cast is safe because the cache contains the full entry data
  return {
    pages: [
      { items: filteredEntries as unknown as EntryListItemForPlaceholder[], nextCursor: undefined },
    ],
    pageParams: [undefined],
  };
}

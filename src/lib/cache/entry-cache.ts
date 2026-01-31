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
  updates: Partial<{ read: boolean; starred: boolean; score: number | null; implicitScore: number }>
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
 * Entry context for targeted cache updates.
 */
export interface EntryContext {
  id: string;
  subscriptionId: string | null;
  type: "web" | "email" | "saved";
  starred: boolean;
}

/**
 * Affected scope info for targeted cache updates.
 */
export interface AffectedScope {
  tagIds: Set<string>;
  hasUncategorized: boolean;
}

/**
 * Updates entries in only the affected cached entry lists.
 * Uses the entry context and affected scope to skip unrelated caches.
 *
 * @param queryClient - React Query client for cache access
 * @param entries - Entries with their context
 * @param updates - Fields to update (read, starred)
 * @param scope - Affected tags and uncategorized flag from server response
 */
export function updateEntriesInAffectedListCaches(
  queryClient: QueryClient,
  entries: EntryContext[],
  updates: Partial<{ read: boolean }>,
  scope: AffectedScope
): void {
  if (entries.length === 0) return;

  const entryIdSet = new Set(entries.map((e) => e.id));
  const subscriptionIds = new Set(entries.map((e) => e.subscriptionId).filter(Boolean) as string[]);
  const entryTypes = new Set(entries.map((e) => e.type));
  const hasStarred = entries.some((e) => e.starred);

  // Get all cached entry list queries
  const infiniteQueries = queryClient.getQueriesData<InfiniteData>({
    queryKey: [["entries", "list"]],
  });

  for (const [queryKey, data] of infiniteQueries) {
    if (!data?.pages) continue;

    // Extract filters from query key
    const keyMeta = queryKey[1] as TRPCQueryKey | undefined;
    const filters: EntryListFilters = keyMeta?.input ?? {};

    // Check if this cache could contain any of the affected entries
    if (!shouldUpdateEntryListCache(filters, subscriptionIds, entryTypes, hasStarred, scope)) {
      continue;
    }

    // Update entries in this cache
    queryClient.setQueryData(queryKey, {
      ...data,
      pages: data.pages.map((page) => ({
        ...page,
        items: page.items.map((entry) => {
          if (entryIdSet.has(entry.id)) {
            return { ...entry, ...updates };
          }
          return entry;
        }),
      })),
    });
  }
}

/**
 * Determines if an entry list cache should be updated based on its filters
 * and the affected entries' context.
 */
function shouldUpdateEntryListCache(
  filters: EntryListFilters,
  subscriptionIds: Set<string>,
  entryTypes: Set<string>,
  hasStarred: boolean,
  scope: AffectedScope
): boolean {
  // No filters = All entries view, always update
  const hasNoFilters =
    !filters.subscriptionId &&
    !filters.tagId &&
    !filters.uncategorized &&
    !filters.starredOnly &&
    !filters.type;
  if (hasNoFilters) return true;

  // Subscription filter: only update if an affected entry is in this subscription
  if (filters.subscriptionId) {
    if (!subscriptionIds.has(filters.subscriptionId)) return false;
  }

  // Tag filter: only update if this tag was affected
  if (filters.tagId) {
    if (!scope.tagIds.has(filters.tagId)) return false;
  }

  // Uncategorized filter: only update if uncategorized entries were affected
  if (filters.uncategorized) {
    if (!scope.hasUncategorized) return false;
  }

  // Starred filter: only update if any affected entry is starred
  if (filters.starredOnly) {
    if (!hasStarred) return false;
  }

  // Type filter: only update if an affected entry has this type
  if (filters.type) {
    if (!entryTypes.has(filters.type)) return false;
  }

  return true;
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
 * Entry metadata that can be updated from SSE events.
 */
export interface EntryMetadataUpdate {
  title?: string | null;
  author?: string | null;
  summary?: string | null;
  url?: string | null;
  publishedAt?: Date | null;
}

/**
 * Updates entry metadata in caches.
 * Updates both entries.get (single entry) and entries.list (all lists) caches.
 * Used when entry content changes (e.g., feed refetch, saved article refresh).
 *
 * @param utils - tRPC utils for cache access
 * @param entryId - Entry ID to update
 * @param metadata - New metadata values
 * @param queryClient - React Query client (optional, needed for list cache updates)
 */
export function updateEntryMetadataInCache(
  utils: TRPCClientUtils,
  entryId: string,
  metadata: EntryMetadataUpdate,
  queryClient?: QueryClient
): void {
  // Update entries.get cache
  utils.entries.get.setData({ id: entryId }, (oldData) => {
    if (!oldData) return oldData;
    return {
      ...oldData,
      entry: {
        ...oldData.entry,
        ...(metadata.title !== undefined && { title: metadata.title }),
        ...(metadata.author !== undefined && { author: metadata.author }),
        ...(metadata.summary !== undefined && { summary: metadata.summary }),
        ...(metadata.url !== undefined && { url: metadata.url }),
        ...(metadata.publishedAt !== undefined && { publishedAt: metadata.publishedAt }),
      },
    };
  });

  // Update entries in all cached list queries (if queryClient provided)
  if (queryClient) {
    const updates: Partial<CachedListEntry> = {};
    if (metadata.title !== undefined) updates.title = metadata.title;
    if (metadata.author !== undefined) updates.author = metadata.author;
    if (metadata.summary !== undefined) updates.summary = metadata.summary;
    if (metadata.url !== undefined) updates.url = metadata.url;
    if (metadata.publishedAt !== undefined) updates.publishedAt = metadata.publishedAt;

    if (Object.keys(updates).length > 0) {
      queryClient.setQueriesData<InfiniteData>({ queryKey: [["entries", "list"]] }, (oldData) => {
        if (!oldData?.pages) return oldData;

        return {
          ...oldData,
          pages: oldData.pages.map((page) => ({
            ...page,
            items: page.items.map((entry) => {
              if (entry.id === entryId) {
                return { ...entry, ...updates };
              }
              return entry;
            }),
          })),
        };
      });
    }
  }
}

/**
 * Updates score fields for an entry in caches.
 * Updates both entries.get (single entry) and entries.list (all lists) caches.
 *
 * @param utils - tRPC utils for cache access
 * @param entryId - Entry ID to update
 * @param score - New explicit score (null to clear)
 * @param implicitScore - New implicit score
 * @param queryClient - React Query client (optional, needed for list cache updates)
 */
export function updateEntryScoreInCache(
  utils: TRPCClientUtils,
  entryId: string,
  score: number | null,
  implicitScore: number,
  queryClient?: QueryClient
): void {
  // Update entries.get cache
  utils.entries.get.setData({ id: entryId }, (oldData) => {
    if (!oldData) return oldData;
    return {
      ...oldData,
      entry: { ...oldData.entry, score, implicitScore },
    };
  });

  // Update entries in all cached list queries (if queryClient provided)
  if (queryClient) {
    updateEntriesInListCache(queryClient, [entryId], { score, implicitScore });
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
  updatedAt: Date;
  read: boolean;
  starred: boolean;
  feedTitle: string | null;
  score: number | null;
  implicitScore: number;
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
  updatedAt: Date;
  read: boolean;
  starred: boolean;
  feedTitle: string | null;
  siteName: string | null;
  score: number | null;
  implicitScore: number;
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
 * Finds a cached query matching specific filters.
 */
function findCachedQuery(
  queries: [readonly unknown[], InfiniteData | undefined][],
  matchFilters: (parentFilters: EntryListFilters) => boolean
): InfiniteData | undefined {
  for (const [queryKey, data] of queries) {
    if (!data?.pages?.length) continue;

    const keyMeta = queryKey[1] as TRPCQueryKey | undefined;
    const parentFilters: EntryListFilters = keyMeta?.input ?? {};

    if (matchFilters(parentFilters)) {
      return data;
    }
  }
  return undefined;
}

/**
 * Finds a cached query with preference for exact unreadOnly/starredOnly match.
 * First tries exact match, then falls back to any compatible query.
 */
function findCachedQueryWithPreference(
  queries: [readonly unknown[], InfiniteData | undefined][],
  baseMatch: (pf: EntryListFilters) => boolean,
  filters: EntryListFilters
): InfiniteData | undefined {
  // First try exact match (same unreadOnly/starredOnly)
  let result = findCachedQuery(
    queries,
    (pf) =>
      baseMatch(pf) &&
      !!pf.unreadOnly === !!filters.unreadOnly &&
      !!pf.starredOnly === !!filters.starredOnly &&
      areFiltersCompatible(pf, filters)
  );

  // Fall back to any compatible match
  if (!result) {
    result = findCachedQuery(queries, (pf) => baseMatch(pf) && areFiltersCompatible(pf, filters));
  }

  return result;
}

/**
 * Checks if two filter sets are exactly equal (for self-cache lookup).
 */
function filtersEqual(a: EntryListFilters, b: EntryListFilters): boolean {
  return (
    a.subscriptionId === b.subscriptionId &&
    a.tagId === b.tagId &&
    !!a.uncategorized === !!b.uncategorized &&
    a.type === b.type &&
    !!a.unreadOnly === !!b.unreadOnly &&
    !!a.starredOnly === !!b.starredOnly &&
    (a.sortOrder ?? "newest") === (b.sortOrder ?? "newest")
  );
}

/**
 * Finds placeholder data from a parent list cache that can be used while the actual query loads.
 * Walks up the hierarchy looking for cached data:
 *
 * 1. Self-cache: exact same query already cached (e.g., "All" returning to "All")
 * 2. For subscriptions: tag list (if subscription is in a tag) → "All" list
 * 3. For tags/starred/other: "All" list
 *
 * Within each level, prefers exact unreadOnly/starredOnly match, then falls back to compatible.
 *
 * @param queryClient - React Query client for cache access
 * @param filters - Requested filters for the entry list
 * @param subscriptions - Subscription data for tag filtering
 * @returns Placeholder data in infinite query format, or undefined if no suitable parent found
 */
export function findParentListPlaceholderData(
  queryClient: QueryClient,
  filters: EntryListFilters,
  subscriptions?: SubscriptionInfo[]
): TypedInfiniteData | undefined {
  const queries = queryClient.getQueriesData<InfiniteData>({
    queryKey: [["entries", "list"]],
  });

  // 1. Check for exact match first (self-cache)
  // This handles "All" using its own cache when navigating back, etc.
  const exactMatch = findCachedQuery(queries, (pf) => filtersEqual(pf, filters));
  if (exactMatch) {
    // Return cached data directly, no filtering needed
    return {
      pages: exactMatch.pages.map((p) => ({
        items: p.items as unknown as EntryListItemForPlaceholder[],
        nextCursor: p.nextCursor,
      })),
      pageParams: exactMatch.pageParams as (string | undefined)[],
    };
  }

  let parentData: InfiniteData | undefined;

  // 2. For subscription pages, try the subscription's tag list
  if (filters.subscriptionId && subscriptions) {
    const subscription = subscriptions.find((s) => s.id === filters.subscriptionId);
    const tagIds = subscription?.tags.map((t) => t.id) ?? [];

    for (const tagId of tagIds) {
      parentData = findCachedQueryWithPreference(
        queries,
        (pf) => pf.tagId === tagId && !pf.subscriptionId,
        filters
      );
      if (parentData) break;
    }
  }

  // 3. Fall back to "All" list (no subscription/tag/uncategorized filters)
  if (!parentData) {
    parentData = findCachedQueryWithPreference(
      queries,
      (pf) => !pf.subscriptionId && !pf.tagId && !pf.uncategorized,
      filters
    );
  }

  if (!parentData) return undefined;

  // Filter the parent's entries to match the requested filters
  const allEntries = parentData.pages.flatMap((page) => page.items);
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

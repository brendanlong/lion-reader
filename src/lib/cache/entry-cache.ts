/**
 * Entry Cache Helpers
 *
 * Provides placeholder data for Suspense fallbacks by looking up
 * cached entry list data from React Query.
 *
 * Note: Entry state updates (read, starred, score) are handled by
 * TanStack DB collections. This file only contains the placeholder
 * data lookup for EntryListFallback.
 */

import type { QueryClient } from "@tanstack/react-query";

/**
 * Entry data in list cache.
 */
interface CachedListEntry {
  id: string;
  read: boolean;
  starred: boolean;
  subscriptionId?: string | null;
  type?: string;
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
 * Data format for regular queries.
 */
interface SubscriptionListData {
  items: SubscriptionInfo[];
  nextCursor?: string;
}

/**
 * Data format for infinite queries.
 */
interface SubscriptionInfiniteData {
  pages: SubscriptionListData[];
  pageParams: unknown[];
}

/**
 * Looks up subscriptions from the cache for tag/uncategorized filtering.
 * Handles both regular queries and infinite queries (used by sidebar).
 * Returns undefined if not cached.
 */
function getSubscriptionsFromCache(queryClient: QueryClient): SubscriptionInfo[] | undefined {
  const queries = queryClient.getQueriesData<SubscriptionListData | SubscriptionInfiniteData>({
    queryKey: [["subscriptions", "list"]],
  });

  const allSubscriptions: SubscriptionInfo[] = [];
  const seenIds = new Set<string>();

  for (const [, data] of queries) {
    if (!data) continue;

    if ("pages" in data && Array.isArray(data.pages)) {
      for (const page of data.pages) {
        if (page?.items) {
          for (const sub of page.items) {
            if (!seenIds.has(sub.id)) {
              seenIds.add(sub.id);
              allSubscriptions.push(sub);
            }
          }
        }
      }
    } else if ("items" in data && Array.isArray(data.items)) {
      for (const sub of data.items) {
        if (!seenIds.has(sub.id)) {
          seenIds.add(sub.id);
          allSubscriptions.push(sub);
        }
      }
    }
  }

  return allSubscriptions.length > 0 ? allSubscriptions : undefined;
}

/**
 * Query key structure for tRPC infinite queries.
 */
interface TRPCQueryKey {
  input?: EntryListFilters & { limit?: number; cursor?: string };
  type?: string;
}

/**
 * Checks if a parent query's filters are compatible for use as placeholder data.
 */
function areFiltersCompatible(
  parentFilters: EntryListFilters,
  requestedFilters: EntryListFilters
): boolean {
  const parentSort = parentFilters.sortOrder ?? "newest";
  const requestedSort = requestedFilters.sortOrder ?? "newest";
  if (parentSort !== requestedSort) return false;
  if (parentFilters.starredOnly && !requestedFilters.starredOnly) return false;
  if (parentFilters.unreadOnly && !requestedFilters.unreadOnly) return false;
  if (parentFilters.type && parentFilters.type !== requestedFilters.type) return false;
  if (
    parentFilters.subscriptionId &&
    parentFilters.subscriptionId !== requestedFilters.subscriptionId
  )
    return false;
  if (parentFilters.tagId && parentFilters.tagId !== requestedFilters.tagId) return false;
  if (parentFilters.uncategorized && !requestedFilters.uncategorized) return false;
  return true;
}

/**
 * Filters entries from a parent list to match the requested filters.
 */
function filterEntries(
  entries: CachedListEntry[],
  filters: EntryListFilters,
  subscriptions?: SubscriptionInfo[]
): CachedListEntry[] {
  let result = entries;

  if (filters.subscriptionId) {
    result = result.filter((e) => e.subscriptionId === filters.subscriptionId);
  }

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

  if (filters.uncategorized && subscriptions) {
    const uncategorizedSubscriptionIds = new Set(
      subscriptions.filter((sub) => sub.tags.length === 0).map((sub) => sub.id)
    );
    result = result.filter(
      (e) => e.subscriptionId && uncategorizedSubscriptionIds.has(e.subscriptionId as string)
    );
  }

  if (filters.starredOnly) {
    result = result.filter((e) => e.starred);
  }

  if (filters.unreadOnly) {
    result = result.filter((e) => !e.read);
  }

  if (filters.type) {
    result = result.filter((e) => e.type === filters.type);
  }

  return result;
}

/**
 * Entry list item structure for placeholder data.
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

interface TypedPage {
  items: EntryListItemForPlaceholder[];
  nextCursor?: string;
}

interface TypedInfiniteData {
  pages: TypedPage[];
  pageParams: (string | undefined)[];
}

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

function findCachedQueryWithPreference(
  queries: [readonly unknown[], InfiniteData | undefined][],
  baseMatch: (pf: EntryListFilters) => boolean,
  filters: EntryListFilters
): InfiniteData | undefined {
  let result = findCachedQuery(
    queries,
    (pf) =>
      baseMatch(pf) &&
      !!pf.unreadOnly === !!filters.unreadOnly &&
      !!pf.starredOnly === !!filters.starredOnly &&
      areFiltersCompatible(pf, filters)
  );

  if (!result) {
    result = findCachedQuery(queries, (pf) => baseMatch(pf) && areFiltersCompatible(pf, filters));
  }

  return result;
}

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
 * For tag/uncategorized filtering, automatically looks up subscriptions from the cache.
 *
 * @param queryClient - React Query client for cache access
 * @param filters - Requested filters for the entry list
 * @returns Placeholder data in infinite query format, or undefined if no suitable parent found
 */
export function findParentListPlaceholderData(
  queryClient: QueryClient,
  filters: EntryListFilters
): TypedInfiniteData | undefined {
  const needsSubscriptions = filters.tagId || filters.uncategorized;
  const subscriptions = needsSubscriptions ? getSubscriptionsFromCache(queryClient) : undefined;

  if (needsSubscriptions && !subscriptions) {
    return undefined;
  }

  const queries = queryClient.getQueriesData<InfiniteData>({
    queryKey: [["entries", "list"]],
  });

  // 1. Check for exact match first (self-cache)
  const exactMatch = findCachedQuery(queries, (pf) => filtersEqual(pf, filters));
  if (exactMatch) {
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

  // 3. Fall back to "All" list
  if (!parentData) {
    parentData = findCachedQueryWithPreference(
      queries,
      (pf) => !pf.subscriptionId && !pf.tagId && !pf.uncategorized,
      filters
    );
  }

  if (!parentData) return undefined;

  const allEntries = parentData.pages.flatMap((page) => page.items);
  const filteredEntries = filterEntries(allEntries, filters, subscriptions);

  if (filteredEntries.length === 0) return undefined;

  return {
    pages: [
      { items: filteredEntries as unknown as EntryListItemForPlaceholder[], nextCursor: undefined },
    ],
    pageParams: [undefined],
  };
}

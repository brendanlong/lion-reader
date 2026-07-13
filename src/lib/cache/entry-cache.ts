/**
 * Entry Cache Helpers
 *
 * Functions for updating entry state in React Query cache.
 *
 * Strategy:
 * - For individual entry views (entries.get): update directly
 * - For entry lists (entries.list): update in place without invalidation
 *   (entries stay visible until navigation; useEntryListRefreshOnNavigate
 *   invalidates entry lists when the pathname changes)
 * - For counts (subscriptions, tags): update directly via count-cache helpers
 */

import type { QueryClient } from "@tanstack/react-query";
import type { TRPCClientUtils } from "@/lib/trpc/client";
import { findCachedSubscription } from "./count-cache";

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
  updates: Partial<{
    read: boolean;
    starred: boolean;
  }>
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
 * A snapshot of the read/starred state of every cached `entries.get` entry,
 * taken at the moment a `fetchNextPage` begins. Diffed against the post-fetch
 * state by `reconcileListFromChangedEntryGets` to find which entries changed
 * during the fetch window. See `snapshotEntryGetStates`.
 */
export type EntryGetStateSnapshot = Map<string, { read: boolean; starred: boolean }>;

/**
 * Snapshots the read/starred state of every cached `entries.get` entry. Call
 * this immediately before starting a `fetchNextPage`, and pass the result to
 * `reconcileListFromChangedEntryGets` after the fetch settles. See #1081.
 */
export function snapshotEntryGetStates(queryClient: QueryClient): EntryGetStateSnapshot {
  const getQueries = queryClient.getQueriesData<{
    entry: { id: string; read: boolean; starred: boolean };
  }>({ queryKey: [["entries", "get"]] });

  const snapshot: EntryGetStateSnapshot = new Map();
  for (const [, data] of getQueries) {
    if (data?.entry) {
      snapshot.set(data.entry.id, { read: data.entry.read, starred: data.entry.starred });
    }
  }
  return snapshot;
}

/**
 * Re-asserts onto the `entries.list` caches the read/starred state of any
 * `entries.get` entry that **changed during a just-completed `fetchNextPage`**
 * (compared to `before`, snapshotted at fetch start by `snapshotEntryGetStates`).
 *
 * Why this exists: React Query's `infiniteQueryBehavior` snapshots the existing
 * pages when a `fetchNextPage` begins and, on completion, replaces the query
 * data with `snapshot + newPage` — silently dropping any `setQueryData` applied
 * to the old pages while the fetch was in flight. j/k navigation routinely
 * triggers this: opening an entry near the end auto-marks it read (a list
 * `setQueryData`) at the same moment the container fires `fetchNextPage`, so the
 * completing fetch reverts the entry to unread.
 *
 * Why the diff (not a blanket re-assert from `entries.get`): `entries.get` is
 * NOT universally kept in lockstep with the list — `mark_all_read` invalidates
 * `entries.list` but never touches `entries.get` (neither the SSE handler nor
 * the acting-tab mutation). A blanket re-assert would resurrect a stale
 * `entries.get` value (e.g. an entry prefetched-unread, then marked read by
 * mark_all_read) back into a freshly-refetched list. Restricting to entries
 * whose `entries.get` state actually *changed during the fetch window* captures
 * exactly the writes that could have been clobbered (a clobber only affects
 * writes made after the fetch started) while leaving untouched-and-therefore-
 * possibly-stale gets alone (#1081).
 *
 * Only touches list rows whose value differs, so unchanged item identities are
 * preserved (keeps EntryListItem's memo effective).
 *
 * Residual limitation: a brand-new entry inserted into the list by an SSE
 * `new_entry` during the fetch has no `entries.get` entry, so it can't be
 * restored here; it reappears on the next navigation-triggered list refresh.
 */
export function reconcileListFromChangedEntryGets(
  queryClient: QueryClient,
  before: EntryGetStateSnapshot
): void {
  const getQueries = queryClient.getQueriesData<{
    entry: { id: string; read: boolean; starred: boolean };
  }>({ queryKey: [["entries", "get"]] });

  const changed = new Map<string, { read: boolean; starred: boolean }>();
  for (const [, data] of getQueries) {
    if (!data?.entry) continue;
    const prev = before.get(data.entry.id);
    // Apply an entry only if its entries.get state changed since fetch start (or
    // the get first appeared during the fetch — a fresh, server-authoritative
    // read). A get already in its current state before the fetch can't have been
    // clobbered by this fetch, so re-applying it would only risk resurrecting
    // list state a concurrent refetch legitimately replaced.
    if (!prev || prev.read !== data.entry.read || prev.starred !== data.entry.starred) {
      changed.set(data.entry.id, { read: data.entry.read, starred: data.entry.starred });
    }
  }
  if (changed.size === 0) return;

  queryClient.setQueriesData<InfiniteData>({ queryKey: [["entries", "list"]] }, (oldData) => {
    if (!oldData?.pages) return oldData;

    let didChange = false;
    const pages = oldData.pages.map((page) => ({
      ...page,
      items: page.items.map((entry) => {
        const state = changed.get(entry.id);
        if (state && (entry.read !== state.read || entry.starred !== state.starred)) {
          didChange = true;
          return { ...entry, ...state };
        }
        return entry;
      }),
    }));

    return didChange ? { ...oldData, pages } : oldData;
  });
}

/**
 * Affected scope info for targeted cache updates.
 */
export interface AffectedScope {
  tagIds: Set<string>;
  hasUncategorized: boolean;
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
 * Note: Count updates are applied separately from absolute server-provided
 * counts (setEntryRelatedCounts / setBulkCounts) without invalidation.
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

    // An entry that just became unread belongs in unreadOnly caches that were
    // fetched while it was read and so don't contain it (e.g. mark-unread in
    // "Show All", then toggle back to "Unread only" — the toggle switches
    // query keys without a refetch). The in-place update above can't add
    // rows, so insert from another cache's copy of the entry.
    if (!read) {
      restoreUnreadEntriesToListCaches(queryClient, entryIds);
    }
  }
}

/**
 * Inserts entries that just became unread into the cached lists that lack
 * them (they were read when those caches were fetched, so the server omitted
 * them from unreadOnly results). The entry's full row is taken from whichever
 * list cache contains it; entries in no list cache are skipped — no cached
 * view is missing them. Insertion is deduped and filter-targeted by
 * insertEntryIntoListCaches, so caches that already show the entry are
 * untouched.
 *
 * @param queryClient - React Query client for cache access
 * @param entryIds - Entries that changed to unread
 */
export function restoreUnreadEntriesToListCaches(
  queryClient: QueryClient,
  entryIds: string[]
): void {
  for (const entryId of entryIds) {
    const item = findEntryInListCache(queryClient, entryId);
    if (item) {
      insertEntryIntoListCaches(queryClient, { ...item, read: false });
    }
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
 * Entry data from the list (lightweight, no content).
 *
 * A type alias rather than an interface so it gets an implicit index
 * signature and is directly assignable to CachedListEntry (no casts).
 */
export type EntryListItem = {
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
  siteName: string | null;
};

/**
 * The entries.list input keys insertEntryIntoListCaches knows how to honor.
 * Caches whose input contains any other key are skipped (fail-safe: the entry
 * appears on the next navigation-triggered refresh instead of live), so a
 * future filter added to entries.list can't silently receive wrong inserts.
 */
const INSERT_SUPPORTED_FILTER_KEYS = new Set([
  "subscriptionId",
  "tagId",
  "uncategorized",
  "unreadOnly",
  "starredOnly",
  "sortOrder",
  "sortBy",
  "type",
  "query",
  "limit",
  "cursor",
  "direction",
]);

/**
 * Inserts a new entry into the cached entry lists it belongs to, in sorted
 * position, so it appears live without a refetch (new_entry SSE/sync events).
 *
 * Uses the same filter matching (shouldUpdateEntryListCache) as the read/starred
 * list updates to skip unrelated caches. Tag/uncategorized membership is derived from the cached
 * subscription (the client's authority on which tags a subscription has —
 * per-entry correct on both the live SSE and catch-up sync paths, unlike the
 * event's counts, whose tag list is a batch-wide union on the catch-up path).
 * When the subscription isn't cached, tag/uncategorized caches are
 * conservatively skipped and pick the entry up on the next navigation refresh.
 *
 * Additional safeguards:
 * - Skips caches whose membership/ordering can't be reproduced client-side:
 *   search results, Recently Read, and any cache whose input has filter keys
 *   this helper doesn't recognize (see INSERT_SUPPORTED_FILTER_KEYS).
 * - Skips unreadOnly caches for already-read entries (catch-up sync can
 *   deliver entries read on another device) and the insert when the entry
 *   sorts beyond the loaded pagination window (it will arrive with the page
 *   that covers it).
 * - Deduplicates by ID, so the same event delivered by both the live SSE
 *   stream and a reconnect catch-up sync inserts only once.
 *
 * @param queryClient - React Query client for cache access
 * @param entry - The new entry in entries.list item shape
 */
export function insertEntryIntoListCaches(queryClient: QueryClient, entry: EntryListItem): void {
  const queries = queryClient.getQueriesData<InfiniteData>({
    queryKey: [["entries", "list"]],
  });

  const subscriptionIds = new Set(entry.subscriptionId ? [entry.subscriptionId] : []);
  const entryTypes = new Set([entry.type]);

  // Tag/uncategorized scope from the cached subscription. When the
  // subscription isn't cached the scope stays empty, so tag/uncategorized
  // caches are skipped (conservative). Saved articles (subscriptionId null)
  // belong to no tag or uncategorized list, so the empty scope is exact for
  // them, not just conservative.
  const subscription = entry.subscriptionId
    ? findCachedSubscription(queryClient, entry.subscriptionId)
    : undefined;
  const scope: AffectedScope = subscription
    ? {
        tagIds: new Set(subscription.tags.map((tag) => tag.id)),
        hasUncategorized: subscription.tags.length === 0,
      }
    : { tagIds: new Set(), hasUncategorized: false };

  for (const [queryKey, data] of queries) {
    if (!data?.pages?.length) continue;

    const keyMeta = queryKey[1] as TRPCQueryKey | undefined;
    const input = (keyMeta?.input ?? {}) as EntryListFilters & Record<string, unknown>;

    // Only insert into caches whose filters we fully understand. Search
    // results are relevance-ranked and Recently Read sorts by readChangedAt
    // (which a new entry doesn't have) — can't insert correctly.
    const hasUnknownFilter = Object.keys(input).some(
      (key) => input[key] !== undefined && !INSERT_SUPPORTED_FILTER_KEYS.has(key)
    );
    if (hasUnknownFilter || input.query || (input.sortBy && input.sortBy !== "published")) {
      continue;
    }

    // Catch-up sync can deliver entries already read on another device;
    // those don't belong in unread-only lists.
    if (input.unreadOnly && entry.read) continue;

    if (!shouldUpdateEntryListCache(input, subscriptionIds, entryTypes, entry.starred, scope)) {
      continue;
    }

    const updated = insertEntryIntoPages(data, entry, input.sortOrder ?? "newest");
    if (updated) {
      queryClient.setQueryData(queryKey, updated);
    }
  }
}

/**
 * Returns a copy of the infinite-query data with the entry inserted in sorted
 * position, or undefined if no insert should happen (duplicate, or the entry
 * sorts beyond the loaded pagination window).
 *
 * The sort mirrors the server's ORDER BY COALESCE(published_at, fetched_at),
 * id (descending for "newest", ascending for "oldest"). Page boundaries don't
 * matter for correctness — pages are rendered flattened and their stored
 * cursors are unaffected by the insert.
 */
function insertEntryIntoPages(
  data: InfiniteData,
  entry: EntryListItem,
  sortOrder: "newest" | "oldest"
): InfiniteData | undefined {
  // Dedupe by ID (idempotent under SSE + catch-up sync double delivery)
  if (data.pages.some((page) => page.items.some((item) => item.id === entry.id))) {
    return undefined;
  }

  // Cached values are usually already Date objects (tRPC's transformer);
  // avoid allocating a new Date per comparison in that common case.
  const sortTime = (publishedAt: unknown, fetchedAt: unknown): number => {
    const value = publishedAt ?? fetchedAt;
    return value instanceof Date ? value.getTime() : new Date(value as string | number).getTime();
  };
  const entryTime = sortTime(entry.publishedAt, entry.fetchedAt);

  const belongsBefore = (other: CachedListEntry): boolean => {
    const otherTime = sortTime(other.publishedAt, other.fetchedAt);
    if (sortOrder === "newest") {
      return entryTime > otherTime || (entryTime === otherTime && entry.id > other.id);
    }
    return entryTime < otherTime || (entryTime === otherTime && entry.id < other.id);
  };

  const insertAt = (pageIndex: number, itemIndex: number): InfiniteData => ({
    ...data,
    pages: data.pages.map((page, i) =>
      i === pageIndex
        ? {
            ...page,
            items: [...page.items.slice(0, itemIndex), entry, ...page.items.slice(itemIndex)],
          }
        : page
    ),
  });

  for (let pageIndex = 0; pageIndex < data.pages.length; pageIndex++) {
    const itemIndex = data.pages[pageIndex].items.findIndex(belongsBefore);
    if (itemIndex !== -1) {
      return insertAt(pageIndex, itemIndex);
    }
  }

  // Sorts after everything loaded: append only if the list is fully loaded;
  // otherwise the entry lives beyond the pagination window and will arrive
  // with the page that covers it.
  const lastPageIndex = data.pages.length - 1;
  if (data.pages[lastPageIndex].nextCursor !== undefined) {
    return undefined;
  }
  return insertAt(lastPageIndex, data.pages[lastPageIndex].items.length);
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
 * Filter options for entry list queries.
 */
export interface EntryListFilters {
  subscriptionId?: string;
  tagId?: string;
  uncategorized?: boolean;
  unreadOnly?: boolean;
  starredOnly?: boolean;
  sortOrder?: "newest" | "oldest";
  sortBy?: "published" | "readChanged";
  type?: "web" | "email" | "saved";
  query?: string;
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
  // Look up subscriptions.list cache - handles both query and infinite query formats
  const queries = queryClient.getQueriesData<SubscriptionListData | SubscriptionInfiniteData>({
    queryKey: [["subscriptions", "list"]],
  });

  const allSubscriptions: SubscriptionInfo[] = [];
  const seenIds = new Set<string>();

  for (const [, data] of queries) {
    if (!data) continue;

    // Check if it's infinite query format (has pages array)
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
    }
    // Regular query format (has items directly)
    else if ("items" in data && Array.isArray(data.items)) {
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
  // Look up subscriptions from cache for tag/uncategorized filtering
  // Note: subscriptionId filtering doesn't need the subscriptions cache - it filters directly by entry.subscriptionId
  const needsSubscriptions = filters.tagId || filters.uncategorized;
  const subscriptions = needsSubscriptions ? getSubscriptionsFromCache(queryClient) : undefined;

  // If we need subscriptions for filtering but can't find them, show skeleton
  // rather than showing incorrect/unfiltered data
  if (needsSubscriptions && !subscriptions) {
    return undefined;
  }
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

/**
 * Entries Collections
 *
 * Two collection types:
 *
 * 1. **Global entries collection** (local-only): Singleton for SSE state updates,
 *    fallback lookups, and detail view overlays. Populated from view collection
 *    results and SSE events.
 *
 * 2. **View entries collection** (on-demand, query-backed): Per-view/filter
 *    collection that drives the entry list UI. Created per route/filter set,
 *    fetches pages from the server on demand as the user scrolls.
 *    Uses `useLiveInfiniteQuery` for rendering.
 */

import { createCollection, localOnlyCollectionOptions } from "@tanstack/react-db";
import { queryCollectionOptions } from "@tanstack/query-db-collection";
import type { QueryClient, InfiniteData } from "@tanstack/react-query";
import type { EntryListItem } from "./types";
import type { EntryType } from "@/lib/queries/entries-list-input";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Entry list item with computed sort key for client-side ordering */
export interface SortedEntryListItem extends EntryListItem {
  _sortMs: number;
}

/** Server response from entries.list */
interface EntriesListResponse {
  items: EntryListItem[];
  nextCursor?: string;
}

/** Filter params baked into a view collection */
export interface EntriesViewFilters {
  subscriptionId?: string;
  tagId?: string;
  uncategorized?: boolean;
  unreadOnly: boolean;
  starredOnly?: boolean;
  sortOrder: "newest" | "oldest";
  type?: EntryType;
  limit: number;
}

// ---------------------------------------------------------------------------
// Global entries collection (local-only)
// ---------------------------------------------------------------------------

/**
 * Creates the global entries collection as a local-only store.
 *
 * Used for:
 * - SSE `entry_state_changed` / `entry_updated` writes
 * - `EntryContentFallback` lookups
 * - Cross-view state that persists across route changes
 */
export function createEntriesCollection() {
  return createCollection(
    localOnlyCollectionOptions({
      id: "entries",
      getKey: (item: EntryListItem) => item.id,
    })
  );
}

export type EntriesCollection = ReturnType<typeof createEntriesCollection>;

// ---------------------------------------------------------------------------
// View entries collection (on-demand, query-backed)
// ---------------------------------------------------------------------------

/**
 * Generates a stable string key for a filter combination.
 * Used as the collection ID suffix and for cache key matching.
 */
export function stableFilterKey(filters: EntriesViewFilters): string {
  return JSON.stringify([
    filters.subscriptionId ?? null,
    filters.tagId ?? null,
    filters.uncategorized ?? null,
    filters.unreadOnly,
    filters.starredOnly ?? null,
    filters.sortOrder,
    filters.type ?? null,
    filters.limit,
  ]);
}

/**
 * Checks the React Query cache for SSR-prefetched entries.list data.
 *
 * The server prefetches via `trpc.entries.list.prefetchInfinite(input)` which
 * stores data under a key where `cursor` and `direction` are stripped by tRPC:
 *   [["entries", "list"], { input: { ...inputWithoutCursorAndDirection }, type: "infinite" }]
 *
 * We look this up to avoid a redundant first-page fetch.
 */
function checkSSRPrefetchCache(
  queryClient: QueryClient,
  filters: EntriesViewFilters
): EntriesListResponse | null {
  // Build the tRPC infinite query key format.
  // tRPC strips `cursor` and `direction` from infinite query keys
  // (see getQueryKeyInternal in @trpc/react-query), so we must NOT include them.
  const input = {
    subscriptionId: filters.subscriptionId,
    tagId: filters.tagId,
    uncategorized: filters.uncategorized,
    unreadOnly: filters.unreadOnly,
    starredOnly: filters.starredOnly,
    sortOrder: filters.sortOrder,
    type: filters.type,
    limit: filters.limit,
  };
  const tRPCKey = [["entries", "list"], { input, type: "infinite" }];
  const data = queryClient.getQueryData<InfiniteData<EntriesListResponse>>(tRPCKey);
  if (data?.pages?.[0]) {
    return data.pages[0];
  }
  return null;
}

/**
 * Creates an on-demand entries collection for a specific view/filter set.
 *
 * The collection fetches pages from the server via cursor-based pagination,
 * bridging TanStack DB's offset-based `loadSubset` to our cursor API.
 *
 * @param queryClient - The shared QueryClient instance
 * @param fetchEntries - Function to fetch a page of entries from the server
 * @param filters - The filter parameters for this view
 */
export function createViewEntriesCollection(
  queryClient: QueryClient,
  fetchEntries: (params: {
    subscriptionId?: string;
    tagId?: string;
    uncategorized?: boolean;
    unreadOnly: boolean;
    starredOnly?: boolean;
    sortOrder: "newest" | "oldest";
    type?: EntryType;
    cursor?: string;
    limit: number;
  }) => Promise<EntriesListResponse>,
  filters: EntriesViewFilters
) {
  // Maps offset → nextCursor for bridging offset-based loading to cursor-based API
  const cursorByOffset = new Map<number, string>();

  return createCollection(
    queryCollectionOptions({
      id: `entries-view-${stableFilterKey(filters)}`,
      syncMode: "on-demand" as const,
      queryKey: ["entries-view", stableFilterKey(filters)],
      queryClient,
      getKey: (item: SortedEntryListItem) => item.id,
      staleTime: Infinity,
      queryFn: async (ctx) => {
        const opts = ctx.meta?.loadSubsetOptions as { offset?: number; limit?: number } | undefined;
        const offset = opts?.offset ?? 0;
        const limit = opts?.limit ?? filters.limit;

        // For the first page, check SSR-prefetched React Query cache
        if (offset === 0) {
          const prefetched = checkSSRPrefetchCache(queryClient, filters);
          if (prefetched) {
            if (prefetched.nextCursor) {
              cursorByOffset.set(prefetched.items.length, prefetched.nextCursor);
            }
            return prefetched;
          }
        }

        // Map offset to cursor for subsequent pages
        const cursor = offset > 0 ? cursorByOffset.get(offset) : undefined;
        if (offset > 0 && !cursor) {
          // No cursor for this offset — shouldn't happen with sequential loading
          return { items: [] };
        }

        const result = await fetchEntries({
          subscriptionId: filters.subscriptionId,
          tagId: filters.tagId,
          uncategorized: filters.uncategorized,
          unreadOnly: filters.unreadOnly,
          starredOnly: filters.starredOnly,
          sortOrder: filters.sortOrder,
          type: filters.type,
          cursor,
          limit,
        });

        if (result.nextCursor) {
          cursorByOffset.set(offset + result.items.length, result.nextCursor);
        }

        return result;
      },
      select: (data: EntriesListResponse): SortedEntryListItem[] =>
        data.items.map((item) => ({
          ...item,
          _sortMs: new Date(item.publishedAt ?? item.fetchedAt).getTime(),
        })),
    })
  );
}

export type ViewEntriesCollection = ReturnType<typeof createViewEntriesCollection>;

/**
 * TanStack DB Collections
 *
 * Central module for creating and accessing all collections.
 * Collections are created once per browser session (tied to the QueryClient lifecycle).
 *
 * Architecture:
 *   Server ──(tRPC)──> TanStack Query ──> TanStack DB Collections
 *                                            │
 *   SSE events ──────────────────────> Collection writes
 *                                            │
 *                                       Live Queries
 *                                      (differential dataflow)
 *                                            │
 *                                            ▼
 *                                       Components
 *                                   (useLiveSuspenseQuery)
 */

import type { QueryClient, QueryCacheNotifyEvent } from "@tanstack/react-query";
import {
  createSubscriptionsCollection,
  type SubscriptionsCollection,
  type TagSubscriptionsCollection,
} from "./subscriptions";
import {
  createTagsCollection,
  type TagsCollection,
  TRPC_TAGS_LIST_KEY,
  type TagsListResponse,
} from "./tags";
import {
  createEntriesCollection,
  type EntriesCollection,
  type ViewEntriesCollection,
} from "./entries";
import { createCountsCollection, type CountsCollection } from "./counts";
import type { CountRecord, TagItem, UncategorizedCounts } from "./types";

/**
 * tRPC query key prefix for entries.count queries.
 * Full key format: [["entries", "count"], { input: {...}, type: "query" }]
 */
const ENTRIES_COUNT_KEY_PATH = ["entries", "count"] as const;

export type {
  Subscription,
  EntryListItem,
  TagItem,
  CountRecord,
  UncategorizedCounts,
} from "./types";
export type { SubscriptionsCollection, TagSubscriptionsCollection } from "./subscriptions";
export type { TagsCollection } from "./tags";
export type { EntriesCollection } from "./entries";
export type { ViewEntriesCollection } from "./entries";
export type { CountsCollection } from "./counts";

/**
 * All collections grouped together for convenient access.
 *
 * `activeViewCollection` is set by the SuspendingEntryList component to register
 * the current view's on-demand collection. Mutations and SSE handlers write to it
 * so changes propagate to the live query (in addition to the global entries collection).
 */
export interface Collections {
  subscriptions: SubscriptionsCollection;
  tags: TagsCollection;
  entries: EntriesCollection;
  counts: CountsCollection;
  /** Active per-tag subscription collections, keyed by filter key.
   * Registered by TagSubscriptionList, used by writes to propagate unread count changes. */
  tagSubscriptionCollections: Map<string, TagSubscriptionsCollection>;
  /** The active on-demand view collection, set by useViewEntriesCollection */
  activeViewCollection: ViewEntriesCollection | null;
  /**
   * Invalidate the active view collection's query cache to trigger a refetch.
   * Set by useViewEntriesCollection; no-op when no view collection is active.
   * Call this instead of utils.entries.list.invalidate() to refresh the entry list.
   */
  invalidateActiveView: () => void;
}

/**
 * Fetch functions for populating query-backed collections.
 * These are provided by the TRPCProvider which has access to the tRPC client.
 */
export interface CollectionFetchers {
  fetchTagsAndUncategorized: () => Promise<{
    items: TagItem[];
    uncategorized: UncategorizedCounts;
  }>;
}

/**
 * Result of creating collections, including a cleanup function
 * for unsubscribing from query cache listeners.
 */
export interface CreateCollectionsResult {
  collections: Collections;
  /** Unsubscribe from query cache listeners. Call when collections are destroyed. */
  cleanup: () => void;
}

/**
 * Check if a query key matches the tRPC tags.list key.
 */
function isTagsListKey(queryKey: readonly unknown[]): boolean {
  if (queryKey.length < 2) return false;
  const path = queryKey[0];
  const meta = queryKey[1] as { type?: string } | undefined;
  return (
    Array.isArray(path) &&
    path.length === 2 &&
    path[0] === TRPC_TAGS_LIST_KEY[0][0] &&
    path[1] === TRPC_TAGS_LIST_KEY[0][1] &&
    meta?.type === TRPC_TAGS_LIST_KEY[1].type
  );
}

/**
 * Check if a query key matches an entries.count key.
 */
function isEntriesCountKey(queryKey: readonly unknown[]): boolean {
  if (queryKey.length < 2) return false;
  const path = queryKey[0];
  const meta = queryKey[1] as { type?: string } | undefined;
  return (
    Array.isArray(path) &&
    path.length === 2 &&
    path[0] === ENTRIES_COUNT_KEY_PATH[0] &&
    path[1] === ENTRIES_COUNT_KEY_PATH[1] &&
    meta?.type === "query"
  );
}

/**
 * Determine the count key ("all", "starred", or "saved") from entries.count input.
 * Returns null if the input doesn't match a known count category.
 */
function getCountKeyFromInput(input: Record<string, unknown> | undefined): string | null {
  if (!input || Object.keys(input).length === 0) {
    return "all";
  }
  if (input.starredOnly === true) {
    return "starred";
  }
  if (input.type === "saved") {
    return "saved";
  }
  return null;
}

/**
 * Write entry counts from an entries.count response to the counts collection.
 */
function syncEntryCount(
  counts: CountsCollection,
  countKey: string,
  data: { total: number; unread: number }
): void {
  const existing = counts.get(countKey);
  if (existing) {
    counts.update(countKey, (draft: CountRecord) => {
      draft.total = data.total;
      draft.unread = data.unread;
    });
  } else {
    counts.insert({ id: countKey, total: data.total, unread: data.unread });
  }
}

/**
 * Write uncategorized counts from a tags.list response to the counts collection.
 */
function syncUncategorizedCounts(counts: CountsCollection, data: TagsListResponse): void {
  const existing = counts.get("uncategorized");
  if (existing) {
    counts.update("uncategorized", (draft: CountRecord) => {
      draft.total = data.uncategorized.feedCount;
      draft.unread = data.uncategorized.unreadCount;
    });
  } else {
    counts.insert({
      id: "uncategorized",
      total: data.uncategorized.feedCount,
      unread: data.uncategorized.unreadCount,
    });
  }
}

/**
 * Creates all TanStack DB collections.
 *
 * Called once in the TRPCProvider when the QueryClient is available.
 * The fetcher functions bridge tRPC with the collection queryFn interface.
 *
 * Sets up a query cache subscription to sync counts from server responses:
 * - Uncategorized counts from tags.list responses
 * - Entry counts (all/starred/saved) from entries.count responses
 *
 * This subscription handles both eager seeding (from SSR-prefetched data)
 * and async updates (when queries resolve after initialization).
 *
 * @param queryClient - The shared QueryClient instance
 * @param fetchers - Functions to fetch data from the tRPC API
 * @returns Collections and a cleanup function to unsubscribe cache listeners
 */
export function createCollections(
  queryClient: QueryClient,
  fetchers: CollectionFetchers
): CreateCollectionsResult {
  const counts = createCountsCollection();

  const collections: Collections = {
    subscriptions: createSubscriptionsCollection(),
    tags: createTagsCollection(queryClient, fetchers.fetchTagsAndUncategorized),
    entries: createEntriesCollection(),
    counts,
    tagSubscriptionCollections: new Map(),
    activeViewCollection: null,
    invalidateActiveView: () => {},
  };

  // Seed uncategorized counts from SSR-prefetched tags.list data
  const prefetchedTagsData = queryClient.getQueryData<TagsListResponse>(
    TRPC_TAGS_LIST_KEY as unknown as readonly unknown[]
  );
  if (prefetchedTagsData) {
    syncUncategorizedCounts(counts, prefetchedTagsData);
  }

  // Seed entry counts from SSR-prefetched entries.count queries
  const countQueries = queryClient.getQueriesData<{ total: number; unread: number }>({
    queryKey: [ENTRIES_COUNT_KEY_PATH.slice()],
  });
  for (const [queryKey, data] of countQueries) {
    if (!data) continue;
    const keyMeta = queryKey[1] as { input?: Record<string, unknown> } | undefined;
    const countKey = getCountKeyFromInput(keyMeta?.input);
    if (countKey) {
      syncEntryCount(counts, countKey, data);
    }
  }

  // Subscribe to query cache updates to sync counts whenever data changes
  const unsubscribe = queryClient.getQueryCache().subscribe((event: QueryCacheNotifyEvent) => {
    if (event.type === "updated" && event.action.type === "success") {
      // Sync uncategorized counts from tags.list
      if (isTagsListKey(event.query.queryKey)) {
        const data = event.query.state.data as TagsListResponse | undefined;
        if (data) {
          syncUncategorizedCounts(counts, data);
        }
      }

      // Sync entry counts from entries.count
      if (isEntriesCountKey(event.query.queryKey)) {
        const data = event.query.state.data as { total: number; unread: number } | undefined;
        if (data) {
          const keyMeta = event.query.queryKey[1] as
            | { input?: Record<string, unknown> }
            | undefined;
          const countKey = getCountKeyFromInput(keyMeta?.input);
          if (countKey) {
            syncEntryCount(counts, countKey, data);
          }
        }
      }
    }
  });

  return { collections, cleanup: unsubscribe };
}

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
import { createSubscriptionsCollection, type SubscriptionsCollection } from "./subscriptions";
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

export type {
  Subscription,
  EntryListItem,
  TagItem,
  CountRecord,
  UncategorizedCounts,
} from "./types";
export type { SubscriptionsCollection } from "./subscriptions";
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
  /** The active on-demand view collection, set by useViewEntriesCollection */
  activeViewCollection: ViewEntriesCollection | null;
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
 * Sets up a query cache subscription to sync uncategorized counts from
 * tags.list responses into the counts collection, keeping the tags
 * collection's `select` function pure.
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
    activeViewCollection: null,
  };

  // Seed uncategorized counts from SSR-prefetched tags.list data
  const prefetchedTagsData = queryClient.getQueryData<TagsListResponse>(
    TRPC_TAGS_LIST_KEY as unknown as readonly unknown[]
  );
  if (prefetchedTagsData) {
    syncUncategorizedCounts(counts, prefetchedTagsData);
  }

  // Subscribe to query cache updates to sync uncategorized counts
  // whenever tags.list data changes (fetches, refetches, SSE invalidations)
  const unsubscribe = queryClient.getQueryCache().subscribe((event: QueryCacheNotifyEvent) => {
    if (
      event.type === "updated" &&
      event.action.type === "success" &&
      isTagsListKey(event.query.queryKey)
    ) {
      const data = event.query.state.data as TagsListResponse | undefined;
      if (data) {
        syncUncategorizedCounts(counts, data);
      }
    }
  });

  return { collections, cleanup: unsubscribe };
}

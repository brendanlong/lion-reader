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

import type { QueryClient } from "@tanstack/react-query";
import { createSubscriptionsCollection, type SubscriptionsCollection } from "./subscriptions";
import { createTagsCollection, type TagsCollection } from "./tags";
import {
  createEntriesCollection,
  type EntriesCollection,
  type ViewEntriesCollection,
} from "./entries";
import { createCountsCollection, type CountsCollection } from "./counts";
import type { TagItem, UncategorizedCounts } from "./types";

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
 * Creates all TanStack DB collections.
 *
 * Called once in the TRPCProvider when the QueryClient is available.
 * The fetcher functions bridge tRPC with the collection queryFn interface.
 *
 * @param queryClient - The shared QueryClient instance
 * @param fetchers - Functions to fetch data from the tRPC API
 */
export function createCollections(
  queryClient: QueryClient,
  fetchers: CollectionFetchers
): Collections {
  // Create counts first since tags needs it for uncategorized counts
  const counts = createCountsCollection();

  return {
    subscriptions: createSubscriptionsCollection(),
    tags: createTagsCollection(queryClient, fetchers.fetchTagsAndUncategorized, counts),
    entries: createEntriesCollection(),
    counts,
    activeViewCollection: null,
  };
}

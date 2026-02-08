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
import { createEntriesCollection, type EntriesCollection } from "./entries";
import { createCountsCollection, type CountsCollection } from "./counts";
import type { Subscription, EntryListItem, TagItem } from "./types";

export type { Subscription, EntryListItem, TagItem, CountRecord } from "./types";
export type { SubscriptionsCollection } from "./subscriptions";
export type { TagsCollection } from "./tags";
export type { EntriesCollection } from "./entries";
export type { CountsCollection } from "./counts";

/**
 * All collections grouped together for convenient access.
 */
export interface Collections {
  subscriptions: SubscriptionsCollection;
  tags: TagsCollection;
  entries: EntriesCollection;
  counts: CountsCollection;
}

/**
 * Fetch functions for populating query-backed collections.
 * These are provided by the TRPCProvider which has access to the tRPC client.
 */
export interface CollectionFetchers {
  fetchSubscriptions: () => Promise<Subscription[]>;
  fetchTags: () => Promise<TagItem[]>;
  fetchEntries: () => Promise<EntryListItem[]>;
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
  return {
    subscriptions: createSubscriptionsCollection(queryClient, fetchers.fetchSubscriptions),
    tags: createTagsCollection(queryClient, fetchers.fetchTags),
    entries: createEntriesCollection(queryClient, fetchers.fetchEntries),
    counts: createCountsCollection(),
  };
}

/**
 * Entries Collection
 *
 * Local-only collection of feed entries, populated incrementally from tRPC
 * infinite query results. Components use tRPC useInfiniteQuery for paginated
 * fetching (cursor-based, SSR-prefetchable), then populate the collection
 * as pages load.
 *
 * The collection provides:
 * - O(1) entry lookup by ID (collection.get(id)) instead of scanning pages
 * - Centralized writes for mutations/SSE (writeUpdate) instead of updating
 *   every infinite query cache
 * - Reactive read via useLiveQuery for components that need live updates
 *
 * Data flow:
 *   tRPC useInfiniteQuery → pages load → upsert into collection
 *   Mutations/SSE → writeUpdate on collection → components re-read merged data
 */

import { createCollection, localOnlyCollectionOptions } from "@tanstack/react-db";
import type { EntryListItem } from "./types";

/**
 * Creates the entries collection as a local-only store.
 *
 * Populated incrementally from tRPC infinite query results (similar to
 * how subscriptions collection is populated from TagSubscriptionList).
 * Mutations and SSE events write directly to the collection.
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

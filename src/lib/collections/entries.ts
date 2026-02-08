/**
 * Entries Collection
 *
 * On-demand synced collection of feed entries.
 * Large dataset, paginated. Fetches only what live queries request.
 * Entries fetched for one view (e.g., "All") are reused in other views
 * (e.g., "Subscription X") since they're stored by ID in the collection.
 */

import { createCollection } from "@tanstack/react-db";
import { queryCollectionOptions } from "@tanstack/query-db-collection";
import type { QueryClient } from "@tanstack/react-query";
import type { EntryListItem } from "./types";

/**
 * Creates the entries collection backed by TanStack Query.
 *
 * Uses on-demand sync mode so only entries requested by live queries are fetched.
 * The queryFn receives filter/sort metadata via loadSubsetOptions, which we'll
 * map to our cursor-based tRPC API in later phases.
 *
 * For Phase 0, this collection is created but not yet consumed by components.
 * The queryFn fetches entries via the provided callback.
 *
 * @param queryClient - The shared QueryClient instance
 * @param fetchEntries - Function to fetch entries from the API
 */
export function createEntriesCollection(
  queryClient: QueryClient,
  fetchEntries: () => Promise<EntryListItem[]>
) {
  return createCollection(
    queryCollectionOptions({
      id: "entries",
      queryKey: ["entries", "collection"] as const,
      queryFn: fetchEntries,
      queryClient,
      getKey: (item: EntryListItem) => item.id,
    })
  );
}

export type EntriesCollection = ReturnType<typeof createEntriesCollection>;

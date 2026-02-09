/**
 * Tags Collection
 *
 * Eager-synced collection of user tags.
 * Small dataset (<100 items), needed everywhere (sidebar, filtering).
 * Loads all tags upfront via a single query.
 *
 * Uses the tRPC tags.list query key directly so it shares the same cache
 * entry as the SSR prefetch, avoiding a duplicate network fetch on load.
 *
 * The tags.list API also returns uncategorized counts. These are synced
 * to the counts collection via a query cache subscription set up in
 * createCollections() (see index.ts), keeping `select` a pure transform.
 */

import { createCollection } from "@tanstack/react-db";
import { queryCollectionOptions } from "@tanstack/query-db-collection";
import type { QueryClient } from "@tanstack/react-query";
import type { TagItem, UncategorizedCounts } from "./types";

/** Shape of the tRPC tags.list response */
export interface TagsListResponse {
  items: TagItem[];
  uncategorized: UncategorizedCounts;
}

/**
 * tRPC query key for tags.list (no input).
 *
 * Format: [path, { type }] where path is the split procedure path.
 * See @trpc/react-query getQueryKeyInternal for the key generation logic.
 */
export const TRPC_TAGS_LIST_KEY = [["tags", "list"], { type: "query" }] as const;

/**
 * Creates the tags collection backed by TanStack Query.
 *
 * Uses `select` to extract the `items` array from the tags.list response.
 * This is a pure transformation with no side effects.
 *
 * @param queryClient - The shared QueryClient instance
 * @param fetchTagsAndUncategorized - Function to fetch tags + uncategorized counts from the API
 */
export function createTagsCollection(
  queryClient: QueryClient,
  fetchTagsAndUncategorized: () => Promise<TagsListResponse>
) {
  return createCollection(
    queryCollectionOptions({
      id: "tags",
      // Use the tRPC query key so the collection shares the SSR-prefetched cache entry
      queryKey: TRPC_TAGS_LIST_KEY as unknown as readonly unknown[],
      queryFn: async () => {
        return await fetchTagsAndUncategorized();
      },
      // Pure transformation: extract items array from the { items, uncategorized } response
      select: (data: TagsListResponse) => data.items,
      queryClient,
      getKey: (item: TagItem) => item.id,
    })
  );
}

export type TagsCollection = ReturnType<typeof createTagsCollection>;

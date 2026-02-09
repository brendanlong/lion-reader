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
 * The tags.list API also returns uncategorized counts, which are stored
 * in the counts collection under the "uncategorized" key.
 */

import { createCollection } from "@tanstack/react-db";
import { queryCollectionOptions } from "@tanstack/query-db-collection";
import type { QueryClient } from "@tanstack/react-query";
import type { CountsCollection } from "./counts";
import type { TagItem, UncategorizedCounts } from "./types";

/** Shape of the tRPC tags.list response */
interface TagsListResponse {
  items: TagItem[];
  uncategorized: UncategorizedCounts;
}

/**
 * tRPC query key for tags.list (no input).
 *
 * Format: [path, { type }] where path is the split procedure path.
 * See @trpc/react-query getQueryKeyInternal for the key generation logic.
 */
const TRPC_TAGS_LIST_KEY = [["tags", "list"], { type: "query" }] as const;

/**
 * Creates the tags collection backed by TanStack Query.
 *
 * Uses `select` to extract the `items` array from the tags.list response.
 * Also writes uncategorized counts to the counts collection as a side effect
 * of the select function (runs on every successful fetch/refetch).
 *
 * @param queryClient - The shared QueryClient instance
 * @param fetchTagsAndUncategorized - Function to fetch tags + uncategorized counts from the API
 * @param countsCollection - The counts collection to write uncategorized counts to
 */
export function createTagsCollection(
  queryClient: QueryClient,
  fetchTagsAndUncategorized: () => Promise<TagsListResponse>,
  countsCollection: CountsCollection
) {
  return createCollection(
    queryCollectionOptions({
      id: "tags",
      // Use the tRPC query key so the collection shares the SSR-prefetched cache entry
      queryKey: TRPC_TAGS_LIST_KEY as unknown as readonly unknown[],
      queryFn: async () => {
        return await fetchTagsAndUncategorized();
      },
      // Extract items array from the { items, uncategorized } response
      select: (data: TagsListResponse) => {
        // Side effect: write uncategorized counts to the counts collection
        const existing = countsCollection.get("uncategorized");
        if (existing) {
          countsCollection.update("uncategorized", (draft) => {
            draft.total = data.uncategorized.feedCount;
            draft.unread = data.uncategorized.unreadCount;
          });
        } else {
          countsCollection.insert({
            id: "uncategorized",
            total: data.uncategorized.feedCount,
            unread: data.uncategorized.unreadCount,
          });
        }

        return data.items;
      },
      queryClient,
      getKey: (item: TagItem) => item.id,
    })
  );
}

export type TagsCollection = ReturnType<typeof createTagsCollection>;

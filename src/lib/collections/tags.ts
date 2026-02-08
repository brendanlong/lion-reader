/**
 * Tags Collection
 *
 * Eager-synced collection of user tags.
 * Small dataset (<100 items), needed everywhere (sidebar, filtering).
 * Loads all tags upfront via a single query.
 *
 * The tags.list API also returns uncategorized counts, which are stored
 * in the counts collection under the "uncategorized" key.
 */

import { createCollection } from "@tanstack/react-db";
import { queryCollectionOptions } from "@tanstack/query-db-collection";
import type { QueryClient } from "@tanstack/react-query";
import type { CountsCollection } from "./counts";
import type { TagItem, UncategorizedCounts } from "./types";

/**
 * Creates the tags collection backed by TanStack Query.
 *
 * Uses `select` to extract the `items` array from the tags.list response.
 * Also writes uncategorized counts to the counts collection as a side effect.
 *
 * @param queryClient - The shared QueryClient instance
 * @param fetchTagsAndUncategorized - Function to fetch tags + uncategorized counts from the API
 * @param countsCollection - The counts collection to write uncategorized counts to
 */
export function createTagsCollection(
  queryClient: QueryClient,
  fetchTagsAndUncategorized: () => Promise<{
    items: TagItem[];
    uncategorized: UncategorizedCounts;
  }>,
  countsCollection: CountsCollection
) {
  return createCollection(
    queryCollectionOptions({
      id: "tags",
      queryKey: ["tags", "listAll"] as const,
      queryFn: async () => {
        const result = await fetchTagsAndUncategorized();

        // Store uncategorized counts in the counts collection
        const existing = countsCollection.get("uncategorized");
        if (existing) {
          countsCollection.utils.writeUpdate({
            id: "uncategorized",
            total: result.uncategorized.feedCount,
            unread: result.uncategorized.unreadCount,
          });
        } else {
          countsCollection.utils.writeInsert({
            id: "uncategorized",
            total: result.uncategorized.feedCount,
            unread: result.uncategorized.unreadCount,
          });
        }

        return result.items;
      },
      queryClient,
      getKey: (item: TagItem) => item.id,
    })
  );
}

export type TagsCollection = ReturnType<typeof createTagsCollection>;

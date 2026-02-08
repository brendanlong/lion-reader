/**
 * Tags Collection
 *
 * Eager-synced collection of user tags.
 * Small dataset (<100 items), needed everywhere (sidebar, filtering).
 * Loads all tags upfront via a single query.
 */

import { createCollection } from "@tanstack/react-db";
import { queryCollectionOptions } from "@tanstack/query-db-collection";
import type { QueryClient } from "@tanstack/react-query";
import type { TagItem } from "./types";

/**
 * Creates the tags collection backed by TanStack Query.
 *
 * Uses `select` to extract the `items` array from the tags.list response.
 * The uncategorized counts are stored separately in the counts collection.
 *
 * @param queryClient - The shared QueryClient instance
 * @param fetchTags - Function to fetch all tags from the API
 */
export function createTagsCollection(
  queryClient: QueryClient,
  fetchTags: () => Promise<TagItem[]>
) {
  return createCollection(
    queryCollectionOptions({
      id: "tags",
      queryKey: ["tags", "listAll"] as const,
      queryFn: fetchTags,
      queryClient,
      getKey: (item: TagItem) => item.id,
    })
  );
}

export type TagsCollection = ReturnType<typeof createTagsCollection>;

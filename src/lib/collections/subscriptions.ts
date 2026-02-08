/**
 * Subscriptions Collection
 *
 * Eager-synced collection of user subscriptions.
 * Small dataset (<1000 items), needed everywhere (sidebar, entry views).
 * Loads all subscriptions upfront via a single query.
 */

import { createCollection } from "@tanstack/react-db";
import { queryCollectionOptions } from "@tanstack/query-db-collection";
import type { QueryClient } from "@tanstack/react-query";
import type { Subscription } from "./types";

/**
 * Creates the subscriptions collection backed by TanStack Query.
 *
 * Uses `select` to extract the `items` array from the paginated response.
 * The queryKey matches what tRPC uses for `subscriptions.list` with no params,
 * so the collection automatically picks up data prefetched by SSR.
 *
 * @param queryClient - The shared QueryClient instance
 * @param fetchSubscriptions - Function to fetch all subscriptions from the API
 */
export function createSubscriptionsCollection(
  queryClient: QueryClient,
  fetchSubscriptions: () => Promise<Subscription[]>
) {
  return createCollection(
    queryCollectionOptions({
      id: "subscriptions",
      queryKey: ["subscriptions", "listAll"] as const,
      queryFn: fetchSubscriptions,
      queryClient,
      getKey: (item: Subscription) => item.id,
    })
  );
}

export type SubscriptionsCollection = ReturnType<typeof createSubscriptionsCollection>;

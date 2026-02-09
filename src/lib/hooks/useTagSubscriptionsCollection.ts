/**
 * useTagSubscriptionsCollection Hook
 *
 * Creates and manages a per-tag on-demand subscriptions collection.
 * The collection fetches pages from the server as the user scrolls
 * in the sidebar tag section.
 *
 * A new collection is created when the tag/uncategorized filter changes.
 */

"use client";

import { useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useVanillaClient } from "@/lib/trpc/vanilla-client";
import {
  createTagSubscriptionsCollection,
  stableTagFilterKey,
  type TagSubscriptionFilters,
} from "@/lib/collections/subscriptions";

/**
 * Creates an on-demand subscriptions collection for a tag section.
 *
 * @param filters - Tag/uncategorized filter and page limit
 * @returns The on-demand collection instance
 */
export function useTagSubscriptionsCollection(filters: TagSubscriptionFilters) {
  const queryClient = useQueryClient();
  const vanillaClient = useVanillaClient();

  const filterKey = useMemo(() => stableTagFilterKey(filters), [filters]);

  const collection = useMemo(
    () =>
      createTagSubscriptionsCollection(
        queryClient,
        (params) => vanillaClient.subscriptions.list.query(params),
        filters
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: recreate on filter change
    [filterKey, queryClient, vanillaClient]
  );

  return { collection, filterKey };
}

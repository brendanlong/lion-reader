/**
 * useViewEntriesCollection Hook
 *
 * Creates and manages a per-view on-demand entries collection.
 * The collection fetches pages from the server as the user scrolls,
 * bridging TanStack DB's offset-based loading to our cursor-based API.
 *
 * A new collection is created when the filter set changes (route navigation).
 * The old collection is cleaned up when its subscriber count drops to 0.
 *
 * Also registers the collection as `activeViewCollection` on the Collections
 * object so mutations and SSE handlers can write to it.
 */

"use client";

import { useEffect, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useVanillaClient } from "@/lib/trpc/vanilla-client";
import { useCollections } from "@/lib/collections/context";
import {
  createViewEntriesCollection,
  stableFilterKey,
  type EntriesViewFilters,
} from "@/lib/collections/entries";

/**
 * Creates an on-demand entries collection for the current view filters.
 * Recreates the collection when filters change (new route/filter combination).
 *
 * Registers the collection as `activeViewCollection` on the shared Collections
 * object so mutations and SSE event handlers can propagate state changes.
 *
 * @param filters - The active filter set for this view
 * @returns The on-demand collection instance and its filter key
 */
export function useViewEntriesCollection(filters: EntriesViewFilters) {
  const queryClient = useQueryClient();
  const vanillaClient = useVanillaClient();
  const collections = useCollections();

  // Stable key for memoization — only recreate collection when filters actually change
  const filterKey = useMemo(() => stableFilterKey(filters), [filters]);

  const collection = useMemo(
    () =>
      createViewEntriesCollection(
        queryClient,
        (params) => vanillaClient.entries.list.query(params),
        filters
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: recreate on filter change
    [filterKey, queryClient, vanillaClient]
  );

  // Register as active view collection for mutations/SSE writes,
  // and set invalidateActiveView to invalidate this collection's backing queries
  useEffect(() => {
    collections.activeViewCollection = collection;
    const queryKey = ["entries-view", filterKey];
    collections.invalidateActiveView = () => {
      queryClient.invalidateQueries({ queryKey });
    };
    return () => {
      // Only clear if we're still the active one (avoid race with new mount)
      if (collections.activeViewCollection === collection) {
        collections.activeViewCollection = null;
        collections.invalidateActiveView = () => {};
      }
    };
  }, [collections, collection, queryClient, filterKey]);

  return { collection, filterKey };
}

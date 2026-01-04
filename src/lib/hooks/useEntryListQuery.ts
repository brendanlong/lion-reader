/**
 * useEntryListQuery Hook
 *
 * Manages the infinite query for entry lists and provides navigation
 * that automatically loads more entries when approaching list boundaries.
 *
 * This hook keeps the query mounted even when viewing an entry, enabling
 * seamless swiping/navigation beyond the initially loaded entries.
 */

"use client";

import { useMemo, useCallback, useRef, useEffect } from "react";
import { trpc } from "@/lib/trpc/client";

/**
 * Filter options for the entry list query.
 */
export interface EntryListQueryFilters {
  feedId?: string;
  tagId?: string;
  uncategorized?: boolean;
  unreadOnly?: boolean;
  starredOnly?: boolean;
  sortOrder?: "newest" | "oldest";
}

/**
 * Entry data needed for keyboard/swipe navigation.
 */
export interface EntryNavigationData {
  id: string;
  url: string | null;
  read: boolean;
  starred: boolean;
}

/**
 * Options for the useEntryListQuery hook.
 */
export interface UseEntryListQueryOptions {
  /**
   * Filter options for the query.
   */
  filters: EntryListQueryFilters;

  /**
   * Number of entries per page.
   * @default 20
   */
  pageSize?: number;

  /**
   * Currently open entry ID (for navigation context).
   */
  openEntryId?: string | null;

  /**
   * Number of entries from the end at which to prefetch the next page.
   * @default 3
   */
  prefetchThreshold?: number;
}

/**
 * Result returned by the useEntryListQuery hook.
 */
export interface UseEntryListQueryResult {
  /**
   * All entries loaded so far (flattened from all pages).
   */
  entries: EntryNavigationData[];

  /**
   * Whether the initial load is in progress.
   */
  isLoading: boolean;

  /**
   * Whether there was an error loading entries.
   */
  isError: boolean;

  /**
   * Error message if isError is true.
   */
  errorMessage?: string;

  /**
   * Whether more entries are being fetched.
   */
  isFetchingNextPage: boolean;

  /**
   * Whether there are more entries to load.
   */
  hasNextPage: boolean;

  /**
   * Fetch the next page of entries.
   */
  fetchNextPage: () => void;

  /**
   * Refetch all entries.
   */
  refetch: () => void;

  /**
   * The next entry ID relative to the open entry (for prefetching).
   */
  nextEntryId?: string;

  /**
   * The previous entry ID relative to the open entry (for prefetching).
   */
  previousEntryId?: string;

  /**
   * Navigate to the next entry, loading more if needed.
   * Returns the entry ID to navigate to, or undefined if at the end.
   */
  getNextEntryId: () => string | undefined;

  /**
   * Navigate to the previous entry.
   * Returns the entry ID to navigate to, or undefined if at the start.
   */
  getPreviousEntryId: () => string | undefined;

  /**
   * Prefetch entry data on mousedown (before click completes).
   */
  prefetchEntry: (entryId: string) => void;
}

/**
 * Hook for managing entry list queries with navigation support.
 *
 * Unlike using the infinite query directly in EntryList, this hook
 * stays mounted even when viewing an entry, enabling seamless
 * navigation beyond initially loaded entries.
 */
export function useEntryListQuery(options: UseEntryListQueryOptions): UseEntryListQueryResult {
  const { filters, pageSize = 20, openEntryId, prefetchThreshold = 3 } = options;

  const utils = trpc.useUtils();

  // Track if we've triggered a fetch to avoid duplicate calls
  const fetchingRef = useRef(false);

  // Use infinite query for cursor-based pagination
  const {
    data,
    isLoading,
    isError,
    error,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    refetch,
  } = trpc.entries.list.useInfiniteQuery(
    {
      feedId: filters.feedId,
      tagId: filters.tagId,
      uncategorized: filters.uncategorized,
      unreadOnly: filters.unreadOnly,
      starredOnly: filters.starredOnly,
      sortOrder: filters.sortOrder,
      limit: pageSize,
    },
    {
      getNextPageParam: (lastPage) => lastPage.nextCursor,
      refetchOnMount: true,
    }
  );

  // Flatten all pages into a single array of entries
  const entries: EntryNavigationData[] = useMemo(() => {
    return (
      data?.pages.flatMap((page) =>
        page.items.map((entry) => ({
          id: entry.id,
          url: entry.url,
          read: entry.read,
          starred: entry.starred,
        }))
      ) ?? []
    );
  }, [data?.pages]);

  // Calculate next and previous entry IDs for prefetching
  const { nextEntryId, previousEntryId, currentIndex } = useMemo(() => {
    if (!openEntryId) {
      return { nextEntryId: undefined, previousEntryId: undefined, currentIndex: -1 };
    }

    const idx = entries.findIndex((e) => e.id === openEntryId);
    if (idx === -1) {
      return { nextEntryId: undefined, previousEntryId: undefined, currentIndex: -1 };
    }

    return {
      nextEntryId: idx < entries.length - 1 ? entries[idx + 1].id : undefined,
      previousEntryId: idx > 0 ? entries[idx - 1].id : undefined,
      currentIndex: idx,
    };
  }, [openEntryId, entries]);

  // Proactively load more entries when approaching the end of the list
  useEffect(() => {
    if (
      currentIndex >= 0 &&
      entries.length > 0 &&
      entries.length - currentIndex <= prefetchThreshold &&
      hasNextPage &&
      !isFetchingNextPage &&
      !fetchingRef.current
    ) {
      fetchingRef.current = true;
      fetchNextPage().finally(() => {
        fetchingRef.current = false;
      });
    }
  }, [
    currentIndex,
    entries.length,
    prefetchThreshold,
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
  ]);

  // Get next entry ID, triggering a fetch if near the end
  const getNextEntryId = useCallback((): string | undefined => {
    if (entries.length === 0) return undefined;

    const idx = openEntryId ? entries.findIndex((e) => e.id === openEntryId) : -1;

    if (idx === -1) {
      // Nothing selected, return the first entry
      return entries[0]?.id;
    }

    if (idx < entries.length - 1) {
      // Return next entry
      return entries[idx + 1].id;
    }

    // At the last entry - return undefined (we already prefetch proactively)
    return undefined;
  }, [entries, openEntryId]);

  // Get previous entry ID
  const getPreviousEntryId = useCallback((): string | undefined => {
    if (entries.length === 0) return undefined;

    const idx = openEntryId ? entries.findIndex((e) => e.id === openEntryId) : -1;

    if (idx === -1) {
      // Nothing selected, return the last entry
      return entries[entries.length - 1]?.id;
    }

    if (idx > 0) {
      // Return previous entry
      return entries[idx - 1].id;
    }

    // At the first entry
    return undefined;
  }, [entries, openEntryId]);

  // Prefetch entry data on mousedown
  const prefetchEntry = useCallback(
    (entryId: string) => {
      utils.entries.get.fetch({ id: entryId });
    },
    [utils]
  );

  // Wrap fetchNextPage to reset the fetching ref
  const wrappedFetchNextPage = useCallback(() => {
    fetchNextPage();
  }, [fetchNextPage]);

  return {
    entries,
    isLoading,
    isError,
    errorMessage: error?.message,
    isFetchingNextPage,
    hasNextPage: hasNextPage ?? false,
    fetchNextPage: wrappedFetchNextPage,
    refetch,
    nextEntryId,
    previousEntryId,
    getNextEntryId,
    getPreviousEntryId,
    prefetchEntry,
  };
}

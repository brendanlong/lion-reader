/**
 * useEntryListQuery Hook
 *
 * Manages the infinite query for entry lists and provides navigation
 * that automatically loads more entries when approaching list boundaries.
 *
 * This hook keeps the query mounted even when viewing an entry, enabling
 * seamless swiping/navigation beyond the initially loaded entries.
 *
 * Refetch strategy: The query uses staleTime: Infinity so it never automatically
 * refetches. The Sidebar explicitly invalidates entries.list when the user clicks
 * a navigation link. This prevents read entries from disappearing while browsing,
 * and ensures fresh data when intentionally navigating to a view.
 */

"use client";

import { useMemo, useCallback, useRef, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { trpc } from "@/lib/trpc/client";
import { findParentListPlaceholderData } from "@/lib/cache/entry-cache";
import { type EntryType } from "./useEntryMutations";

/**
 * Filter options for the entry list query.
 */
interface EntryListQueryFilters {
  subscriptionId?: string;
  tagId?: string;
  uncategorized?: boolean;
  unreadOnly?: boolean;
  starredOnly?: boolean;
  sortOrder?: "newest" | "oldest";
  /** Filter by entry type (web, email, saved) */
  type?: EntryType;
}

/**
 * Entry data for list display and navigation.
 * Includes all fields needed for rendering and keyboard/swipe navigation.
 */
export interface EntryListData {
  id: string;
  feedId: string;
  subscriptionId: string | null;
  type: EntryType;
  url: string | null;
  title: string | null;
  author: string | null;
  summary: string | null;
  publishedAt: Date | null;
  fetchedAt: Date;
  read: boolean;
  starred: boolean;
  feedTitle: string | null;
}

/**
 * Subscription info for tag filtering in placeholder data.
 */
interface SubscriptionForPlaceholder {
  id: string;
  tags: Array<{ id: string }>;
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
   * @default 10
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

  /**
   * Subscription data for tag filtering in placeholder data.
   * Pass the result of subscriptions.list query to enable placeholder data
   * for tag-filtered and uncategorized views.
   */
  subscriptions?: SubscriptionForPlaceholder[];
}

/**
 * Result returned by the useEntryListQuery hook.
 */
export interface UseEntryListQueryResult {
  /**
   * All entries loaded so far (flattened from all pages).
   */
  entries: EntryListData[];

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
}

/**
 * Hook for managing entry list queries with navigation support.
 *
 * Unlike using the infinite query directly in EntryList, this hook
 * stays mounted even when viewing an entry, enabling seamless
 * navigation beyond initially loaded entries.
 */
export function useEntryListQuery(options: UseEntryListQueryOptions): UseEntryListQueryResult {
  const { filters, pageSize = 10, openEntryId, prefetchThreshold = 3, subscriptions } = options;

  // Get query client for placeholder data lookup
  const queryClient = useQueryClient();

  // Track if we've triggered a fetch to avoid duplicate calls
  const fetchingRef = useRef(false);

  // Track last known adjacent entries for when the current entry is filtered out
  // This prevents navigation breaking when the open entry disappears from the list
  const lastKnownNextRef = useRef<string | undefined>(undefined);
  const lastKnownPrevRef = useRef<string | undefined>(undefined);

  // Use infinite query for cursor-based pagination
  // Note: refetchOnMount is false - we handle refetch on pathname change via effect below
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
      subscriptionId: filters.subscriptionId,
      tagId: filters.tagId,
      uncategorized: filters.uncategorized,
      unreadOnly: filters.unreadOnly,
      starredOnly: filters.starredOnly,
      sortOrder: filters.sortOrder,
      type: filters.type,
      limit: pageSize,
    },
    {
      getNextPageParam: (lastPage) => lastPage.nextCursor,
      // Never automatically refetch - the Sidebar invalidates on navigation
      // This prevents read entries from disappearing while browsing
      staleTime: Infinity,
      refetchOnMount: false,
      refetchOnWindowFocus: false,
      // Use parent list as placeholder data for immediate display while fetching
      // This provides entries from a broader cached list (e.g., "All" list for subscription view)
      placeholderData: () => findParentListPlaceholderData(queryClient, filters, subscriptions),
    }
  );

  // Flatten all pages into a single array of entries
  const entries: EntryListData[] = useMemo(() => {
    return (
      data?.pages.flatMap((page) =>
        page.items.map((entry) => ({
          id: entry.id,
          feedId: entry.feedId,
          subscriptionId: entry.subscriptionId,
          type: entry.type,
          url: entry.url,
          title: entry.title,
          author: entry.author,
          summary: entry.summary,
          publishedAt: entry.publishedAt,
          fetchedAt: entry.fetchedAt,
          read: entry.read,
          starred: entry.starred,
          feedTitle: entry.feedTitle,
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
      // Entry not found (likely filtered out) - return undefined for render
      // getNextEntryId/getPreviousEntryId will use refs as fallback
      return {
        nextEntryId: undefined,
        previousEntryId: undefined,
        currentIndex: -1,
      };
    }

    // Entry found - calculate adjacent entries
    const nextId = idx < entries.length - 1 ? entries[idx + 1].id : undefined;
    const prevId = idx > 0 ? entries[idx - 1].id : undefined;

    return {
      nextEntryId: nextId,
      previousEntryId: prevId,
      currentIndex: idx,
    };
  }, [openEntryId, entries]);

  // Update refs when entry is found - runs after render to comply with React rules
  // These refs are used as fallback in getNextEntryId/getPreviousEntryId when entry is filtered out
  useEffect(() => {
    if (nextEntryId !== undefined || previousEntryId !== undefined) {
      lastKnownNextRef.current = nextEntryId;
      lastKnownPrevRef.current = previousEntryId;
    }
  }, [nextEntryId, previousEntryId]);

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

  // Get next entry ID, using remembered value if current entry is filtered out
  // Refs are accessed only in this callback, not during render
  const getNextEntryId = useCallback((): string | undefined => {
    if (entries.length === 0) return undefined;

    const idx = openEntryId ? entries.findIndex((e) => e.id === openEntryId) : -1;

    if (idx === -1) {
      // Entry not found - use remembered next entry if available
      if (lastKnownNextRef.current) {
        return lastKnownNextRef.current;
      }
      // Fall back to first entry if nothing remembered
      return entries[0]?.id;
    }

    if (idx < entries.length - 1) {
      // Return next entry
      return entries[idx + 1].id;
    }

    // At the last entry - return undefined (we already prefetch proactively)
    return undefined;
  }, [entries, openEntryId]);

  // Get previous entry ID, using remembered value if current entry is filtered out
  // Refs are accessed only in this callback, not during render
  const getPreviousEntryId = useCallback((): string | undefined => {
    if (entries.length === 0) return undefined;

    const idx = openEntryId ? entries.findIndex((e) => e.id === openEntryId) : -1;

    if (idx === -1) {
      // Entry not found - use remembered previous entry if available
      if (lastKnownPrevRef.current) {
        return lastKnownPrevRef.current;
      }
      // Fall back to last entry if nothing remembered
      return entries[entries.length - 1]?.id;
    }

    if (idx > 0) {
      // Return previous entry
      return entries[idx - 1].id;
    }

    // At the first entry
    return undefined;
  }, [entries, openEntryId]);

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
  };
}

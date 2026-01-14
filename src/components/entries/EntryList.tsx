/**
 * EntryList Component
 *
 * Displays a paginated list of entries with infinite scroll.
 * Supports filtering by feed, unread only, and starred only.
 */

"use client";

import { useEffect, useRef, useCallback, useMemo } from "react";
import { trpc } from "@/lib/trpc/client";
import { type EntryListData, useMergedEntries, type EntryType } from "@/lib/hooks";
import { EntryListItem } from "./EntryListItem";
import { EntryListSkeleton } from "./EntryListSkeleton";
import {
  ArticleListEmpty,
  ArticleListError,
  ArticleListLoadingMore,
  ArticleListEnd,
} from "@/components/articles/ArticleListStates";

/**
 * Filter options for the entry list.
 */
interface EntryListFilters {
  /**
   * Filter by specific subscription ID.
   */
  subscriptionId?: string;

  /**
   * Filter by tag ID (entries from subscriptions with this tag).
   */
  tagId?: string;

  /**
   * Show only entries from uncategorized feeds (feeds with no tags).
   */
  uncategorized?: boolean;

  /**
   * Show only unread entries.
   */
  unreadOnly?: boolean;

  /**
   * Show only starred entries.
   */
  starredOnly?: boolean;

  /**
   * Sort order: "newest" (default) or "oldest".
   */
  sortOrder?: "newest" | "oldest";
}

/**
 * Entry data passed to parent for keyboard actions.
 */
export interface EntryListEntryData {
  id: string;
  url: string | null;
  read: boolean;
  starred: boolean;
  subscriptionId?: string | null;
}

/**
 * External query state that can be provided to avoid creating a duplicate query.
 * Use with useEntryListQuery hook to keep the query mounted while viewing entries.
 */
export interface ExternalQueryState {
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
}

interface EntryListProps {
  /**
   * Filter options for the list.
   * Required when not providing externalEntries.
   */
  filters?: EntryListFilters;

  /**
   * Callback when an entry is clicked.
   */
  onEntryClick?: (entryId: string) => void;

  /**
   * Number of entries to fetch per page.
   * @default 20
   */
  pageSize?: number;

  /**
   * Custom empty state message.
   */
  emptyMessage?: string;

  /**
   * Currently selected entry ID (for keyboard navigation highlighting).
   */
  selectedEntryId?: string | null;

  /**
   * Callback to receive entry data when entries are loaded.
   * Used by parent components for keyboard navigation and actions.
   * Not needed when using externalEntries.
   */
  onEntriesLoaded?: (entries: EntryListEntryData[]) => void;

  /**
   * Callback when the read status indicator is clicked.
   * entryType and subscriptionId are required (but subscriptionId can be null) to force explicit handling.
   */
  onToggleRead?: (
    entryId: string,
    currentlyRead: boolean,
    entryType: EntryType,
    subscriptionId: string | null
  ) => void;

  /**
   * Callback when the star indicator is clicked.
   */
  onToggleStar?: (entryId: string, currentlyStarred: boolean) => void;

  /**
   * External entries provided by parent (e.g., from useEntryListQuery).
   * When provided, the component won't create its own query.
   */
  externalEntries?: EntryListData[];

  /**
   * External query state when using externalEntries.
   */
  externalQueryState?: ExternalQueryState;
}

/**
 * EntryList component with infinite scroll.
 */
export function EntryList({
  filters = {},
  onEntryClick,
  pageSize = 20,
  emptyMessage = "No entries to display",
  selectedEntryId,
  onEntriesLoaded,
  onToggleRead,
  onToggleStar,
  externalEntries,
  externalQueryState,
}: EntryListProps) {
  const loadMoreRef = useRef<HTMLDivElement>(null);
  const useExternalData = externalEntries !== undefined && externalQueryState !== undefined;

  // Use infinite query for cursor-based pagination (only when not using external data)
  const internalQuery = trpc.entries.list.useInfiniteQuery(
    {
      subscriptionId: filters.subscriptionId,
      tagId: filters.tagId,
      uncategorized: filters.uncategorized,
      unreadOnly: filters.unreadOnly,
      starredOnly: filters.starredOnly,
      sortOrder: filters.sortOrder,
      limit: pageSize,
    },
    {
      getNextPageParam: (lastPage) => lastPage.nextCursor,
      // Refetch when filters change
      refetchOnMount: true,
      // Disable when using external data
      enabled: !useExternalData,
    }
  );

  // Flatten all pages into a single array of entries (from internal query)
  const internalEntries = useMemo(
    () => internalQuery.data?.pages.flatMap((page) => page.items) ?? [],
    [internalQuery.data?.pages]
  );

  // Use external entries if provided, otherwise use internal query results
  const serverEntries = useExternalData ? externalEntries : internalEntries;

  // Merge server data with Zustand deltas at render time, then filter by view criteria
  const allEntries = useMergedEntries(serverEntries, {
    unreadOnly: filters?.unreadOnly,
    starredOnly: filters?.starredOnly,
  });

  // Query state - use external if provided, otherwise use internal
  const isLoading = useExternalData ? externalQueryState.isLoading : internalQuery.isLoading;
  const isError = useExternalData ? externalQueryState.isError : internalQuery.isError;
  const errorMessage = useExternalData
    ? externalQueryState.errorMessage
    : internalQuery.error?.message;
  const isFetchingNextPage = useExternalData
    ? externalQueryState.isFetchingNextPage
    : internalQuery.isFetchingNextPage;
  const hasNextPage = useExternalData
    ? externalQueryState.hasNextPage
    : (internalQuery.hasNextPage ?? false);
  const fetchNextPage = useExternalData
    ? externalQueryState.fetchNextPage
    : internalQuery.fetchNextPage;
  const refetch = useExternalData ? externalQueryState.refetch : internalQuery.refetch;

  // Notify parent of entry data for keyboard navigation and actions
  // Use delta-merged entries to include optimistic updates
  useEffect(() => {
    if (onEntriesLoaded && !useExternalData) {
      const entries: EntryListEntryData[] = allEntries.map((entry) => ({
        id: entry.id,
        url: entry.url,
        read: entry.read,
        starred: entry.starred,
        subscriptionId: entry.subscriptionId,
      }));
      onEntriesLoaded(entries);
    }
  }, [allEntries, onEntriesLoaded, useExternalData]);

  // Intersection Observer for infinite scroll
  const handleObserver = useCallback(
    (entries: IntersectionObserverEntry[]) => {
      const target = entries[0];
      if (target.isIntersecting && hasNextPage && !isFetchingNextPage) {
        fetchNextPage();
      }
    },
    [fetchNextPage, hasNextPage, isFetchingNextPage]
  );

  useEffect(() => {
    const observer = new IntersectionObserver(handleObserver, {
      root: null,
      rootMargin: "100px",
      threshold: 0,
    });

    const currentRef = loadMoreRef.current;
    if (currentRef) {
      observer.observe(currentRef);
    }

    return () => {
      if (currentRef) {
        observer.unobserve(currentRef);
      }
    };
  }, [handleObserver]);

  // Initial loading state
  if (isLoading) {
    return <EntryListSkeleton count={pageSize > 10 ? 10 : pageSize} />;
  }

  // Error state
  if (isError) {
    return (
      <ArticleListError
        message={errorMessage ?? "Failed to load entries"}
        onRetry={() => refetch()}
      />
    );
  }

  // Empty state
  if (allEntries.length === 0) {
    return <ArticleListEmpty message={emptyMessage} />;
  }

  return (
    <div className="space-y-3">
      {allEntries.map((entry) => (
        <EntryListItem
          key={entry.id}
          entry={entry}
          onClick={onEntryClick}
          selected={selectedEntryId === entry.id}
          onToggleRead={onToggleRead}
          onToggleStar={onToggleStar}
        />
      ))}

      {/* Load more trigger element */}
      <div ref={loadMoreRef} className="h-1" />

      {/* Loading indicator */}
      {isFetchingNextPage && <ArticleListLoadingMore label="Loading more entries..." />}

      {/* End of list indicator */}
      {!hasNextPage && allEntries.length > 0 && <ArticleListEnd message="No more entries" />}
    </div>
  );
}

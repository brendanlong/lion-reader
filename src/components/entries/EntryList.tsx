/**
 * EntryList Component
 *
 * Displays a paginated list of entries with infinite scroll.
 * Supports filtering by feed, unread only, and starred only.
 */

"use client";

import { useEffect, useRef, useCallback, useMemo } from "react";
import { trpc } from "@/lib/trpc/client";
import { type EntryListData, type EntryType } from "@/lib/hooks";
import { useScrollContainer } from "@/components/layout/ScrollContainerContext";
import { EntryListItem, type EntryListItemData } from "./EntryListItem";
import { EntryListSkeleton } from "./EntryListSkeleton";
import {
  EntryListEmpty,
  EntryListError,
  EntryListLoadingMore,
  EntryListEnd,
} from "./EntryListStates";

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

  /**
   * Filter by entry type (web, email, saved).
   */
  type?: EntryType;
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
   * @default 10
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
   * Receives the full entry for context needed for mutations.
   */
  onToggleRead?: (entry: EntryListItemData) => void;

  /**
   * Callback when the star indicator is clicked.
   * Receives the full entry for context needed for mutations.
   */
  onToggleStar?: (entry: EntryListItemData) => void;

  /**
   * External entries provided by parent (e.g., from useEntryListQuery).
   * When provided, the component won't create its own query.
   */
  externalEntries?: EntryListData[];

  /**
   * External query state when using externalEntries.
   */
  externalQueryState?: ExternalQueryState;

  /**
   * CSS value for IntersectionObserver rootMargin.
   * Controls how far from the viewport edge to trigger loading more entries.
   * Larger values trigger earlier loading for smoother scrolling.
   * @default "100px"
   */
  rootMargin?: string;
}

/**
 * EntryList component with infinite scroll.
 */
export function EntryList({
  filters = {},
  onEntryClick,
  pageSize = 10,
  emptyMessage = "No entries to display",
  selectedEntryId,
  onEntriesLoaded,
  onToggleRead,
  onToggleStar,
  externalEntries,
  externalQueryState,
  rootMargin = "100px",
}: EntryListProps) {
  const loadMoreRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useScrollContainer();
  const useExternalData = externalEntries !== undefined && externalQueryState !== undefined;

  // Use infinite query for cursor-based pagination (only when not using external data)
  // Note: refetchOnMount is intentionally not set (defaults to smart behavior based on staleTime)
  // When using external data from useEntryListQuery, that hook handles pathname-based refetching
  const internalQuery = trpc.entries.list.useInfiniteQuery(
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
  const allEntries = useExternalData ? externalEntries : internalEntries;

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
    // Use the scroll container as the root if available, otherwise fall back to viewport
    const root = scrollContainerRef?.current ?? null;

    const observer = new IntersectionObserver(handleObserver, {
      root,
      rootMargin,
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
  }, [handleObserver, rootMargin, scrollContainerRef]);

  // Initial loading state - only show skeleton if we have no entries to display
  // (placeholder data from parent lists provides entries even while loading)
  if (isLoading && allEntries.length === 0) {
    return <EntryListSkeleton count={pageSize > 10 ? 10 : pageSize} />;
  }

  // Error state
  if (isError) {
    return (
      <EntryListError
        message={errorMessage ?? "Failed to load entries"}
        onRetry={() => refetch()}
      />
    );
  }

  // Empty state - only show when not loading (loading with 0 entries shows skeleton above)
  if (!isLoading && allEntries.length === 0) {
    return <EntryListEmpty message={emptyMessage} />;
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
      {isFetchingNextPage && <EntryListLoadingMore label="Loading more entries..." />}

      {/* End of list indicator */}
      {!hasNextPage && allEntries.length > 0 && <EntryListEnd message="No more entries" />}
    </div>
  );
}

/**
 * EntryList Component
 *
 * Displays a paginated list of entries with infinite scroll.
 * Supports filtering by feed, unread only, and starred only.
 */

"use client";

import { useEffect, useRef, useCallback, useMemo } from "react";
import { trpc } from "@/lib/trpc/client";
import { EntryListItem, type EntryListItemData } from "./EntryListItem";
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
export interface EntryListFilters {
  /**
   * Filter by specific feed ID.
   */
  feedId?: string;

  /**
   * Filter by tag ID (entries from feeds with this tag).
   */
  tagId?: string;

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
}

interface EntryListProps {
  /**
   * Filter options for the list.
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
   */
  onEntriesLoaded?: (entries: EntryListEntryData[]) => void;

  /**
   * Callback when the read status indicator is clicked.
   */
  onToggleRead?: (entryId: string, currentlyRead: boolean) => void;

  /**
   * Callback when the star indicator is clicked.
   */
  onToggleStar?: (entryId: string, currentlyStarred: boolean) => void;
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
}: EntryListProps) {
  const loadMoreRef = useRef<HTMLDivElement>(null);

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
      unreadOnly: filters.unreadOnly,
      starredOnly: filters.starredOnly,
      sortOrder: filters.sortOrder,
      limit: pageSize,
    },
    {
      getNextPageParam: (lastPage) => lastPage.nextCursor,
      // Refetch when filters change
      refetchOnMount: true,
    }
  );

  // Get tRPC utils for prefetching on mousedown
  const utils = trpc.useUtils();

  // Prefetch entry data on mousedown (before click completes)
  // This gives a 50-150ms head start with near-zero false positives
  const handlePrefetch = useCallback(
    (entryId: string) => {
      utils.entries.get.fetch({ id: entryId });
    },
    [utils]
  );

  // Flatten all pages into a single array of entries
  const allEntries = useMemo(() => data?.pages.flatMap((page) => page.items) ?? [], [data?.pages]);

  // Notify parent of entry data for keyboard navigation and actions
  useEffect(() => {
    if (onEntriesLoaded) {
      const entries: EntryListEntryData[] = allEntries.map((entry) => ({
        id: entry.id,
        url: entry.url,
        read: entry.read,
        starred: entry.starred,
      }));
      onEntriesLoaded(entries);
    }
  }, [allEntries, onEntriesLoaded]);

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
        message={error?.message ?? "Failed to load entries"}
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
          entry={entry as EntryListItemData}
          onClick={onEntryClick}
          selected={selectedEntryId === entry.id}
          onToggleRead={onToggleRead}
          onToggleStar={onToggleStar}
          onPrefetch={handlePrefetch}
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

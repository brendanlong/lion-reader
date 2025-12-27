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

/**
 * Filter options for the entry list.
 */
export interface EntryListFilters {
  /**
   * Filter by specific feed ID.
   */
  feedId?: string;

  /**
   * Show only unread entries.
   */
  unreadOnly?: boolean;

  /**
   * Show only starred entries.
   */
  starredOnly?: boolean;
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
}

/**
 * Empty state component.
 */
function EntryListEmpty({ message }: { message: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center">
      <svg
        className="mb-4 h-12 w-12 text-zinc-400 dark:text-zinc-500"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        aria-hidden="true"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={1.5}
          d="M19 20H5a2 2 0 01-2-2V6a2 2 0 012-2h10a2 2 0 012 2v1m2 13a2 2 0 01-2-2V7m2 13a2 2 0 002-2V9a2 2 0 00-2-2h-2m-4-3H9M7 16h6M7 8h6v4H7V8z"
        />
      </svg>
      <p className="text-sm text-zinc-500 dark:text-zinc-400">{message}</p>
    </div>
  );
}

/**
 * Error state component.
 */
function EntryListError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center">
      <svg
        className="mb-4 h-12 w-12 text-red-400 dark:text-red-500"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        aria-hidden="true"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={1.5}
          d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
        />
      </svg>
      <p className="mb-4 text-sm text-zinc-500 dark:text-zinc-400">{message}</p>
      <button
        onClick={onRetry}
        className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-800 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
      >
        Try again
      </button>
    </div>
  );
}

/**
 * Loading more indicator shown at bottom during pagination.
 */
function LoadingMore() {
  return (
    <div
      className="flex items-center justify-center py-4"
      role="status"
      aria-label="Loading more entries"
    >
      <svg
        className="h-5 w-5 animate-spin text-zinc-500"
        xmlns="http://www.w3.org/2000/svg"
        fill="none"
        viewBox="0 0 24 24"
        aria-hidden="true"
      >
        <circle
          className="opacity-25"
          cx="12"
          cy="12"
          r="10"
          stroke="currentColor"
          strokeWidth="4"
        />
        <path
          className="opacity-75"
          fill="currentColor"
          d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
        />
      </svg>
      <span className="sr-only">Loading more entries...</span>
    </div>
  );
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
      unreadOnly: filters.unreadOnly,
      starredOnly: filters.starredOnly,
      limit: pageSize,
    },
    {
      getNextPageParam: (lastPage) => lastPage.nextCursor,
      // Refetch when filters change
      refetchOnMount: true,
    }
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
      <EntryListError
        message={error?.message ?? "Failed to load entries"}
        onRetry={() => refetch()}
      />
    );
  }

  // Empty state
  if (allEntries.length === 0) {
    return <EntryListEmpty message={emptyMessage} />;
  }

  return (
    <div className="space-y-3">
      {allEntries.map((entry) => (
        <EntryListItem
          key={entry.id}
          entry={entry as EntryListItemData}
          onClick={onEntryClick}
          selected={selectedEntryId === entry.id}
        />
      ))}

      {/* Load more trigger element */}
      <div ref={loadMoreRef} className="h-1" />

      {/* Loading indicator */}
      {isFetchingNextPage && <LoadingMore />}

      {/* End of list indicator */}
      {!hasNextPage && allEntries.length > 0 && (
        <p className="py-4 text-center text-sm text-zinc-400 dark:text-zinc-500">No more entries</p>
      )}
    </div>
  );
}

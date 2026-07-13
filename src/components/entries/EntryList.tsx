/**
 * EntryList Component
 *
 * Presentational paginated entry list with infinite scroll. The entries and
 * query state are always supplied by the parent container (which owns the
 * `entries.list` query); this component only renders them, wires up the
 * infinite-scroll observer, and shows loading/error/empty states.
 */

"use client";

import { useEffect, useRef, useCallback } from "react";
import type { EntryListData } from "@/lib/hooks/types";
import { useScrollContainer } from "@/components/layout/ScrollContainerContext";
import { useAppearance } from "@/lib/appearance/AppearanceProvider";
import { EntryListItem } from "./EntryListItem";
import { EntryListSkeleton } from "./EntryListSkeleton";
import {
  EntryListEmpty,
  EntryListError,
  EntryListLoadingMore,
  EntryListEnd,
} from "./EntryListStates";

/**
 * Query state for the list, supplied by the parent container that owns the
 * `entries.list` query.
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
   * Callback when an entry is clicked.
   */
  onEntryClick?: (entryId: string) => void;

  /**
   * Callback when mousedown fires on an entry (used for prefetching).
   */
  onEntryMouseDown?: (entryId: string) => void;

  /**
   * Custom empty state message.
   */
  emptyMessage?: string;

  /**
   * Currently selected entry ID (for keyboard navigation highlighting).
   */
  selectedEntryId?: string | null;

  /**
   * Callback when the read status indicator is clicked.
   */
  onToggleRead?: (entryId: string, currentlyRead: boolean) => void;

  /**
   * Callback when the star indicator is clicked.
   */
  onToggleStar?: (entryId: string, currentlyStarred: boolean) => void;

  /**
   * Entries to render (the parent container owns the query).
   */
  externalEntries: EntryListData[];

  /**
   * Query state for the entries (the parent container owns the query).
   */
  externalQueryState: ExternalQueryState;

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
  onEntryClick,
  onEntryMouseDown,
  emptyMessage = "No entries to display",
  selectedEntryId,
  onToggleRead,
  onToggleStar,
  externalEntries: allEntries,
  externalQueryState,
  rootMargin = "100px",
}: EntryListProps) {
  const loadMoreRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useScrollContainer();
  const {
    settings: { listDensity },
  } = useAppearance();

  const {
    isLoading,
    isError,
    errorMessage,
    isFetchingNextPage,
    hasNextPage,
    fetchNextPage,
    refetch,
  } = externalQueryState;

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
    return <EntryListSkeleton count={5} density={listDensity} />;
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

  // Compact density: a single divided list (dividers survive e-paper via the
  // darker `--edge`). Comfortable: gapped bordered cards.
  const listClassName = listDensity === "compact" ? "divide-edge divide-y" : "space-y-3";

  return (
    <div>
      <div className={listClassName}>
        {allEntries.map((entry) => (
          <EntryListItem
            key={entry.id}
            entry={entry}
            onClick={onEntryClick}
            onMouseDown={onEntryMouseDown}
            selected={selectedEntryId === entry.id}
            onToggleRead={onToggleRead}
            onToggleStar={onToggleStar}
            density={listDensity}
          />
        ))}
      </div>

      {/* Load more trigger element */}
      <div ref={loadMoreRef} className="h-1" />

      {/* Loading indicator */}
      {isFetchingNextPage && <EntryListLoadingMore label="Loading more entries..." />}

      {/* End of list indicator */}
      {!hasNextPage && allEntries.length > 0 && <EntryListEnd message="No more entries" />}
    </div>
  );
}

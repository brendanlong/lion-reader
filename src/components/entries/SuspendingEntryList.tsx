/**
 * SuspendingEntryList Component
 *
 * A wrapper around EntryList that uses useSuspenseInfiniteQuery.
 * Suspends until entry data is ready, allowing independent loading
 * from other parts of the page (like entry content).
 *
 * Uses useEntriesListInput to get query input, ensuring cache is shared
 * with the parent's non-suspending query (used for navigation).
 */

"use client";

import { useMemo, useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { trpc } from "@/lib/trpc/client";
import { useEntryMutations } from "@/lib/hooks";
import { useEntryUrlState } from "@/lib/hooks/useEntryUrlState";
import { useKeyboardShortcutsContext } from "@/components/keyboard";
import { useKeyboardShortcuts } from "@/lib/hooks/useKeyboardShortcuts";
import { useUrlViewPreferences } from "@/lib/hooks/useUrlViewPreferences";
import { useEntriesListInput } from "@/lib/hooks/useEntriesListInput";
import { useScrollContainer } from "@/components/layout/ScrollContainerContext";
import { EntryList, type ExternalQueryState } from "./EntryList";

interface SuspendingEntryListProps {
  emptyMessage: string;
}

export function SuspendingEntryList({ emptyMessage }: SuspendingEntryListProps) {
  const { openEntryId, setOpenEntryId } = useEntryUrlState();
  const { showUnreadOnly, sortOrder, toggleShowUnreadOnly } = useUrlViewPreferences();
  const { enabled: keyboardShortcutsEnabled } = useKeyboardShortcutsContext();
  const utils = trpc.useUtils();
  const scrollContainerRef = useScrollContainer();

  // Get query input from URL - shared with parent's non-suspending query
  const queryInput = useEntriesListInput();

  // Suspending query - component suspends until data is ready
  // Shares cache with parent's useInfiniteQuery via same queryInput
  const [data, { fetchNextPage, hasNextPage, isFetchingNextPage, refetch }] =
    trpc.entries.list.useSuspenseInfiniteQuery(queryInput, {
      getNextPageParam: (lastPage) => lastPage.nextCursor,
      staleTime: Infinity,
      refetchOnWindowFocus: false,
    });

  // Flatten entries from all pages
  const entries = useMemo(
    () =>
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
          siteName: entry.siteName,
        }))
      ) ?? [],
    [data?.pages]
  );

  // Compute next/previous entry IDs for keyboard navigation
  // Also compute how close we are to the pagination boundary
  const { nextEntryId, previousEntryId, distanceToEnd } = useMemo(() => {
    if (!openEntryId || entries.length === 0) {
      return { nextEntryId: undefined, previousEntryId: undefined, distanceToEnd: Infinity };
    }
    const currentIndex = entries.findIndex((e) => e.id === openEntryId);
    if (currentIndex === -1) {
      return { nextEntryId: undefined, previousEntryId: undefined, distanceToEnd: Infinity };
    }
    return {
      nextEntryId: currentIndex < entries.length - 1 ? entries[currentIndex + 1].id : undefined,
      previousEntryId: currentIndex > 0 ? entries[currentIndex - 1].id : undefined,
      distanceToEnd: entries.length - 1 - currentIndex,
    };
  }, [openEntryId, entries]);

  // Trigger pagination when navigating close to the end of loaded entries
  const prevDistanceToEnd = useRef(distanceToEnd);
  useEffect(() => {
    // Only trigger when we're getting closer to the end (moving forward)
    // and we're within 3 entries of the end
    const PAGINATION_THRESHOLD = 3;
    if (
      distanceToEnd <= PAGINATION_THRESHOLD &&
      distanceToEnd < prevDistanceToEnd.current &&
      hasNextPage &&
      !isFetchingNextPage
    ) {
      fetchNextPage();
    }
    prevDistanceToEnd.current = distanceToEnd;
  }, [distanceToEnd, hasNextPage, isFetchingNextPage, fetchNextPage]);

  // Scroll to last viewed entry when returning from entry view to list
  // We track the previous openEntryId to know which entry to scroll to
  const prevOpenEntryIdRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    const prevOpenEntryId = prevOpenEntryIdRef.current;
    const isClosing = prevOpenEntryId && !openEntryId;

    if (isClosing) {
      const element = document.querySelector(`[data-entry-id="${prevOpenEntryId}"]`);
      if (element) {
        const scrollContainer = scrollContainerRef?.current;
        const rect = element.getBoundingClientRect();

        let isInView: boolean;
        if (scrollContainer) {
          const containerRect = scrollContainer.getBoundingClientRect();
          isInView = rect.top >= containerRect.top && rect.bottom <= containerRect.bottom;
        } else {
          isInView = rect.top >= 0 && rect.bottom <= window.innerHeight;
        }

        if (!isInView) {
          element.scrollIntoView({ behavior: "instant", block: "center" });
        }
      }
    }

    // Update ref after the effect runs (this is allowed in effects)
    prevOpenEntryIdRef.current = openEntryId;
  }, [openEntryId, scrollContainerRef]);

  // Navigation callbacks for keyboard shortcuts (j/k when viewing an entry)
  const goToNextEntry = useCallback(() => {
    if (nextEntryId) {
      setOpenEntryId(nextEntryId);
    }
  }, [nextEntryId, setOpenEntryId]);

  const goToPreviousEntry = useCallback(() => {
    if (previousEntryId) {
      setOpenEntryId(previousEntryId);
    }
  }, [previousEntryId, setOpenEntryId]);

  // Entry mutations
  const { toggleRead: rawToggleRead, toggleStar } = useEntryMutations();

  const handleToggleRead = useCallback(
    (entryId: string, currentlyRead: boolean) => {
      rawToggleRead(entryId, currentlyRead, true);
    },
    [rawToggleRead]
  );

  // Entry click handler
  const handleEntryClick = useCallback(
    (entryId: string) => {
      setOpenEntryId(entryId);
    },
    [setOpenEntryId]
  );

  // Keyboard shortcuts
  const { selectedEntryId } = useKeyboardShortcuts({
    entries,
    onOpenEntry: setOpenEntryId,
    onClose: () => setOpenEntryId(null),
    isEntryOpen: !!openEntryId,
    openEntryId,
    enabled: keyboardShortcutsEnabled,
    onToggleRead: handleToggleRead,
    onToggleStar: toggleStar,
    onRefresh: () => utils.entries.list.invalidate(),
    onToggleUnreadOnly: toggleShowUnreadOnly,
    onNavigateNext: goToNextEntry,
    onNavigatePrevious: goToPreviousEntry,
  });

  // External query state for EntryList
  const externalQueryState: ExternalQueryState = useMemo(
    () => ({
      isLoading: false, // Suspense handles loading
      isError: false, // ErrorBoundary handles errors
      errorMessage: undefined,
      isFetchingNextPage,
      hasNextPage: hasNextPage ?? false,
      fetchNextPage,
      refetch,
    }),
    [isFetchingNextPage, hasNextPage, fetchNextPage, refetch]
  );

  return (
    <EntryList
      filters={{
        subscriptionId: queryInput.subscriptionId,
        tagId: queryInput.tagId,
        uncategorized: queryInput.uncategorized,
        starredOnly: queryInput.starredOnly,
        type: queryInput.type,
        unreadOnly: showUnreadOnly,
        sortOrder,
      }}
      onEntryClick={handleEntryClick}
      selectedEntryId={selectedEntryId}
      onToggleRead={handleToggleRead}
      onToggleStar={toggleStar}
      externalEntries={entries}
      externalQueryState={externalQueryState}
      emptyMessage={emptyMessage}
    />
  );
}

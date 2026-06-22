/**
 * EntryListContainer Component
 *
 * Stateful container around the presentational EntryList. Owns the
 * `entries.list` query plus all list behavior: keyboard navigation (next/prev,
 * j/k), pagination triggering near the end, scroll restoration on close, entry
 * open/prefetch, and URL state.
 *
 * Loads entries with a non-suspending useInfiniteQuery and renders a smart
 * inline loading fallback (cached entries from parent lists) while the query
 * loads. It deliberately does NOT suspend: a committed Suspense fallback is
 * pinned on screen for React's FALLBACK_THROTTLE_MS (300ms) even on a
 * warm-cache navigation, which made switching list views feel laggy. See
 * "Suspense vs. inline loading" in src/CLAUDE.md.
 *
 * Uses useEntriesListInput to get query input, ensuring cache is shared
 * with the parent's non-suspending query (used for navigation).
 */

"use client";

import { useMemo, useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { trpc } from "@/lib/trpc/client";
import { useEntryMutations } from "@/lib/hooks/useEntryMutations";
import { useEntryUrlState } from "@/lib/hooks/useEntryUrlState";
import { useKeyboardShortcutsContext } from "@/components/keyboard/KeyboardShortcutsProvider";
import { useKeyboardShortcuts } from "@/lib/hooks/useKeyboardShortcuts";
import { useUrlViewPreferences } from "@/lib/hooks/useUrlViewPreferences";
import { useEntriesListInput } from "@/lib/hooks/useEntriesListInput";
import { useIsHydrated } from "@/lib/hooks/useIsHydrated";
import { useScrollContainer } from "@/components/layout/ScrollContainerContext";
import { EntryList, type ExternalQueryState } from "./EntryList";
import { EntryListFallback } from "./EntryListFallback";
import { EntryListSkeleton } from "./EntryListSkeleton";

interface EntryListContainerProps {
  emptyMessage: string;
}

export function EntryListContainer({ emptyMessage }: EntryListContainerProps) {
  const { openEntryId, setOpenEntryId } = useEntryUrlState();
  const { showUnreadOnly, sortOrder, toggleShowUnreadOnly } = useUrlViewPreferences();
  const { enabled: keyboardShortcutsEnabled } = useKeyboardShortcutsContext();
  const utils = trpc.useUtils();
  const scrollContainerRef = useScrollContainer();

  // False during SSR + first client render. The smart (cache-reading) fallback
  // below would mismatch hydration (empty server cache vs. hydrated client
  // cache), so until hydration we render a deterministic skeleton.
  const isHydrated = useIsHydrated();

  // Get query input from URL - shared with parent's non-suspending query
  const queryInput = useEntriesListInput();

  // Non-suspending query so the loading state renders inline (see the
  // `isLoading` branch below) instead of via a Suspense fallback that React
  // would pin for 300ms on warm-cache navigations. `throwOnError` preserves the
  // surrounding ErrorBoundary behavior. Shares cache with the parent's
  // useInfiniteQuery via the same queryInput.
  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, refetch, isLoading } =
    trpc.entries.list.useInfiniteQuery(queryInput, {
      getNextPageParam: (lastPage) => lastPage.nextCursor,
      staleTime: Infinity,
      refetchOnWindowFocus: false,
      throwOnError: true,
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

  // Prefetch entry on mousedown (fires ~100-200ms before click)
  const handleEntryMouseDown = useCallback(
    (entryId: string) => {
      void utils.entries.get.prefetch({ id: entryId });
    },
    [utils]
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

  // Query state for the presentational EntryList
  const externalQueryState: ExternalQueryState = useMemo(
    () => ({
      isLoading,
      isError: false, // throwOnError sends errors to the ErrorBoundary
      errorMessage: undefined,
      isFetchingNextPage,
      hasNextPage: hasNextPage ?? false,
      fetchNextPage,
      refetch,
    }),
    [isLoading, isFetchingNextPage, hasNextPage, fetchNextPage, refetch]
  );

  // Deterministic skeleton on the server + first client render so hydration
  // matches (EntryListFallback reads the cache, which differs between server
  // and client at that point).
  if (!isHydrated) {
    return <EntryListSkeleton count={5} />;
  }

  // Loading state (post-hydration, client-only): show the smart fallback
  // (cached entries from parent lists) inline instead of suspending. Resolved/
  // cached data skips this and renders the real list on first paint. Placeholder
  // rows are clickable since the fallback lives here with the list's handlers.
  if (isLoading && entries.length === 0) {
    return (
      <EntryListFallback
        filters={{
          subscriptionId: queryInput.subscriptionId,
          tagId: queryInput.tagId,
          uncategorized: queryInput.uncategorized,
          starredOnly: queryInput.starredOnly,
          type: queryInput.type,
          unreadOnly: showUnreadOnly,
          sortOrder,
        }}
        skeletonCount={5}
        selectedEntryId={selectedEntryId}
        onEntryClick={handleEntryClick}
      />
    );
  }

  return (
    <EntryList
      onEntryClick={handleEntryClick}
      onEntryMouseDown={handleEntryMouseDown}
      selectedEntryId={selectedEntryId}
      onToggleRead={handleToggleRead}
      onToggleStar={toggleStar}
      externalEntries={entries}
      externalQueryState={externalQueryState}
      emptyMessage={emptyMessage}
    />
  );
}

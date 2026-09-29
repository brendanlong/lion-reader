/**
 * EntryListContainer Component
 *
 * Stateful container around the presentational EntryList. Owns the
 * `entries.list` query plus all list behavior: keyboard navigation (next/prev,
 * j/k), pagination triggering near the end, scroll restoration on close, entry
 * open/prefetch, and URL state.
 *
 * Fetches entries with a non-suspending useInfiniteQuery, renders them from
 * the local entry store, and shows a smart inline loading fallback (stored
 * entries matching the view) while the first page loads. It deliberately does NOT suspend: a committed Suspense fallback is
 * pinned on screen for React's FALLBACK_THROTTLE_MS (300ms) even on a
 * warm-cache navigation, which made switching list views feel laggy. See
 * "Suspense vs. inline loading" in src/CLAUDE.md.
 *
 * Uses useEntriesListInput to get query input, ensuring cache is shared
 * with the parent's non-suspending query (used for navigation).
 */

"use client";

import { useMemo, useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { trpc } from "@/lib/trpc/client";
import { useEntryMutations } from "@/lib/hooks/useEntryMutations";
import { refreshEntryLists } from "@/lib/hooks/useEntryListRefreshOnNavigate";
import { useEntryUrlState } from "@/lib/hooks/useEntryUrlState";
import { useKeyboardShortcutsContext } from "@/components/keyboard/KeyboardShortcutsProvider";
import { useKeyboardShortcuts } from "@/lib/hooks/useKeyboardShortcuts";
import { useUrlViewPreferences } from "@/lib/hooks/useUrlViewPreferences";
import { useEntriesListInput } from "@/lib/hooks/useEntriesListInput";
import { useEntryListEntries } from "@/lib/hooks/useLocalEntries";
import { useCanRenderFromCache } from "@/lib/hooks/useIsHydrated";
import { useScrollContainer } from "@/components/layout/ScrollContainerContext";
import { EntryList, type ExternalQueryState } from "./EntryList";
import { EntryListFallback } from "./EntryListFallback";
import { EntryListSkeleton } from "./EntryListSkeleton";

interface EntryListContainerProps {
  emptyMessage: string;
}

/**
 * The entries either side of the open entry in the loaded list (shared by j/k
 * navigation here and swipe navigation in UnifiedEntriesContent, so the two
 * always agree), plus how many loaded entries remain after it.
 */
export function findAdjacentEntries(
  entries: ReadonlyArray<{ id: string }>,
  openEntryId: string | null
): { nextEntryId?: string; previousEntryId?: string; distanceToEnd: number } {
  const currentIndex = openEntryId ? entries.findIndex((e) => e.id === openEntryId) : -1;
  if (currentIndex === -1) return { distanceToEnd: Infinity };
  return {
    nextEntryId: entries[currentIndex + 1]?.id,
    previousEntryId: entries[currentIndex - 1]?.id,
    distanceToEnd: entries.length - 1 - currentIndex,
  };
}

export function EntryListContainer({ emptyMessage }: EntryListContainerProps) {
  const { openEntryId, setOpenEntryId, closeEntry, entryHref } = useEntryUrlState();
  const { showUnreadOnly, sortOrder, toggleShowUnreadOnly } = useUrlViewPreferences();
  const { enabled: keyboardShortcutsEnabled } = useKeyboardShortcutsContext();
  const utils = trpc.useUtils();
  const queryClient = useQueryClient();
  const scrollContainerRef = useScrollContainer();

  // False during SSR + first client render. The smart (cache-reading) fallback
  // below would mismatch hydration (empty server cache vs. hydrated client
  // cache), so until hydration we render a deterministic skeleton.
  const canRenderFromCache = useCanRenderFromCache();

  // Get query input from URL - shared with parent's non-suspending query
  const queryInput = useEntriesListInput();

  // Non-suspending query so the loading state renders inline (see the
  // `isLoading` branch below) instead of via a Suspense fallback that React
  // would pin for 300ms on warm-cache navigations. `throwOnError` preserves the
  // surrounding ErrorBoundary behavior. Shares cache with the parent's
  // useInfiniteQuery via the same queryInput.
  const { fetchNextPage, hasNextPage, isFetchingNextPage, isLoading } =
    trpc.entries.list.useInfiniteQuery(queryInput, {
      getNextPageParam: (lastPage) => lastPage.nextCursor,
      staleTime: Infinity,
      refetchOnWindowFocus: false,
      throwOnError: true,
    });

  // The query only fetches; the list renders from the local entry store,
  // which the fetched pages are ingested into (src/lib/local-db/). Entry
  // state lives there too, so a next-page fetch can't clobber a read/starred
  // change made while it was in flight.
  const entries = useEntryListEntries(queryInput);

  // Next/previous entry IDs for keyboard navigation, and how close we are to
  // the pagination boundary
  const { nextEntryId, previousEntryId, distanceToEnd } = useMemo(
    () => findAdjacentEntries(entries, openEntryId),
    [openEntryId, entries]
  );

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
      void fetchNextPage();
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
  const { toggleRead, toggleStar } = useEntryMutations();

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
  const { selectedEntryId, setSelectedEntryId } = useKeyboardShortcuts({
    entries,
    onOpenEntry: setOpenEntryId,
    // Escape must close the same way the reader's back affordance does — via
    // `closeEntry`, which pops the history entry opening pushed instead of
    // replacing it and stranding it (#1571).
    onClose: closeEntry,
    openEntryId,
    enabled: keyboardShortcutsEnabled,
    onToggleRead: toggleRead,
    onToggleStar: toggleStar,
    // Route the `r` refresh through the shared helper so it cancels in-flight
    // fetches on inactive lists first (a completing fetch would clear the
    // staleness flag), matching navigation/sidebar refreshes (#1081).
    onRefresh: () => void refreshEntryLists(queryClient),
    onToggleUnreadOnly: toggleShowUnreadOnly,
    onNavigateNext: goToNextEntry,
    onNavigatePrevious: goToPreviousEntry,
  });

  // Sync selection with browser focus so Tabbing to a row makes `m`/`s` act on
  // it (they key off the shortcut selection, which j/k also sets).
  const handleEntryFocus = useCallback(
    (entryId: string) => {
      setSelectedEntryId(entryId);
    },
    [setSelectedEntryId]
  );

  // Query state for the presentational EntryList
  // A list restored from local persistence renders while its first page is
  // still loading; show that as loading more (not the end of the list), which
  // also keeps infinite scroll from requesting a next page mid-load.
  const externalQueryState: ExternalQueryState = useMemo(
    () => ({
      isFetchingNextPage: isFetchingNextPage || isLoading,
      hasNextPage: (hasNextPage ?? false) || isLoading,
      fetchNextPage: () => void fetchNextPage(),
    }),
    [isFetchingNextPage, hasNextPage, isLoading, fetchNextPage]
  );

  // Deterministic skeleton on the server + first client render so hydration
  // matches (EntryListFallback reads the cache, which differs between server
  // and client at that point).
  if (!canRenderFromCache) {
    return <EntryListSkeleton />;
  }

  // Loading state (post-hydration, client-only): show the smart fallback
  // (stored entries matching the view) inline instead of suspending. Resolved/
  // cached data skips this and renders the real list on first paint. Placeholder
  // rows are clickable since the fallback lives here with the list's handlers.
  // Search results and Recently Read can't be approximated from stored entries
  // (membership depends on the query; order on read time), so they show a
  // plain skeleton instead.
  const isServerOrdered =
    !!queryInput.query || (queryInput.sortBy !== undefined && queryInput.sortBy !== "published");
  if (isLoading && entries.length === 0 && isServerOrdered) {
    return <EntryListSkeleton />;
  }
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
        onEntryClick={handleEntryClick}
      />
    );
  }

  return (
    <EntryList
      onEntryClick={handleEntryClick}
      onEntryMouseDown={handleEntryMouseDown}
      getEntryHref={entryHref}
      onEntryFocus={handleEntryFocus}
      selectedEntryId={selectedEntryId}
      onToggleRead={toggleRead}
      onToggleStar={toggleStar}
      externalEntries={entries}
      externalQueryState={externalQueryState}
      emptyMessage={emptyMessage}
    />
  );
}

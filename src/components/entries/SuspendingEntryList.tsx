/**
 * SuspendingEntryList Component
 *
 * Renders the entry list using a TanStack DB on-demand collection.
 * The collection fetches pages from the server as the user scrolls,
 * bridging TanStack DB's offset-based windowing to our cursor-based API.
 *
 * Uses useLiveInfiniteQuery for reactive pagination and useStableEntryList
 * to prevent entries from disappearing when their state changes mid-session
 * (e.g., marking an entry as read while viewing "unread only").
 *
 * Note: Despite the name, this component no longer uses React Suspense.
 * The name is kept for compatibility with the dynamic import in
 * UnifiedEntriesContent. Loading state is handled via isLoading/isReady.
 */

"use client";

import { useMemo, useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { useLiveInfiniteQuery } from "@tanstack/react-db";
import { eq } from "@tanstack/db";
import { trpc } from "@/lib/trpc/client";
import { useEntryMutations } from "@/lib/hooks/useEntryMutations";
import { useEntryUrlState } from "@/lib/hooks/useEntryUrlState";
import { useKeyboardShortcutsContext } from "@/components/keyboard/KeyboardShortcutsProvider";
import { useKeyboardShortcuts } from "@/lib/hooks/useKeyboardShortcuts";
import { useUrlViewPreferences } from "@/lib/hooks/useUrlViewPreferences";
import { useEntriesListInput } from "@/lib/hooks/useEntriesListInput";
import { useScrollContainer } from "@/components/layout/ScrollContainerContext";
import { useCollections } from "@/lib/collections/context";
import { upsertEntriesInCollection } from "@/lib/collections/writes";
import { useViewEntriesCollection } from "@/lib/hooks/useViewEntriesCollection";
import { useStableEntryList } from "@/lib/hooks/useStableEntryList";
import { useEntryNavigationUpdater } from "@/lib/hooks/useEntryNavigation";
import type { EntriesViewFilters } from "@/lib/collections/entries";
import { EntryList, type ExternalQueryState } from "./EntryList";
import { EntryListSkeleton } from "./EntryListSkeleton";

interface SuspendingEntryListProps {
  emptyMessage: string;
}

export function SuspendingEntryList({ emptyMessage }: SuspendingEntryListProps) {
  const { openEntryId, setOpenEntryId } = useEntryUrlState();
  const { showUnreadOnly, sortOrder, toggleShowUnreadOnly } = useUrlViewPreferences();
  const { enabled: keyboardShortcutsEnabled } = useKeyboardShortcutsContext();
  const utils = trpc.useUtils();
  const scrollContainerRef = useScrollContainer();
  const collections = useCollections();

  // Get query input from URL
  const queryInput = useEntriesListInput();

  // Build filters for the on-demand view collection
  const viewFilters: EntriesViewFilters = useMemo(
    () => ({
      subscriptionId: queryInput.subscriptionId,
      tagId: queryInput.tagId,
      uncategorized: queryInput.uncategorized,
      unreadOnly: showUnreadOnly,
      starredOnly: queryInput.starredOnly,
      sortOrder,
      type: queryInput.type,
      limit: queryInput.limit,
    }),
    [queryInput, showUnreadOnly, sortOrder]
  );

  // Create the on-demand view collection (recreates on filter change)
  const { collection: viewCollection, filterKey } = useViewEntriesCollection(viewFilters);

  const sortDescending = sortOrder === "newest";

  // Live infinite query over the view collection
  // Client-side where clauses ensure correct hasNextPage / dataNeeded calculation
  const {
    data: liveData,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isLoading,
    isReady,
  } = useLiveInfiniteQuery(
    (q) => {
      let query = q
        .from({ e: viewCollection })
        .orderBy(({ e }) => e._sortMs, sortDescending ? "desc" : "asc");

      // Client-side filter matching server-side filter for correct pagination
      if (showUnreadOnly) {
        query = query.where(({ e }) => eq(e.read, false));
      }
      if (queryInput.starredOnly) {
        query = query.where(({ e }) => eq(e.starred, true));
      }

      return query.select(({ e }) => ({ ...e }));
    },
    {
      pageSize: queryInput.limit,
      getNextPageParam: (lastPage, allPages) =>
        lastPage.length === queryInput.limit ? allPages.length : undefined,
    },
    [filterKey, sortDescending, showUnreadOnly, queryInput.starredOnly]
  );

  // Display stability: merge live entries with previously-seen entries
  const stableEntries = useStableEntryList(
    liveData ?? [],
    viewCollection,
    filterKey,
    sortDescending
  );

  // Populate global entries collection from live query results.
  // This keeps entries available for SSE state updates, fallback lookups,
  // and the detail view overlay.
  useEffect(() => {
    if (stableEntries.length > 0) {
      upsertEntriesInCollection(collections, stableEntries);
    }
  }, [collections, stableEntries]);

  // Compute next/previous entry IDs for keyboard navigation
  // Also compute how close we are to the pagination boundary
  const { nextEntryId, previousEntryId, distanceToEnd } = useMemo(() => {
    if (!openEntryId || stableEntries.length === 0) {
      return { nextEntryId: undefined, previousEntryId: undefined, distanceToEnd: Infinity };
    }
    const currentIndex = stableEntries.findIndex((e) => e.id === openEntryId);
    if (currentIndex === -1) {
      return { nextEntryId: undefined, previousEntryId: undefined, distanceToEnd: Infinity };
    }
    return {
      nextEntryId:
        currentIndex < stableEntries.length - 1 ? stableEntries[currentIndex + 1].id : undefined,
      previousEntryId: currentIndex > 0 ? stableEntries[currentIndex - 1].id : undefined,
      distanceToEnd: stableEntries.length - 1 - currentIndex,
    };
  }, [openEntryId, stableEntries]);

  // Publish navigation state for swipe gestures in EntryContent
  const updateNavigation = useEntryNavigationUpdater();
  useEffect(() => {
    updateNavigation({ nextEntryId, previousEntryId });
  }, [updateNavigation, nextEntryId, previousEntryId]);

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
    entries: stableEntries,
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

  // Show skeleton while first page loads
  if (isLoading && !isReady) {
    return <EntryListSkeleton count={5} />;
  }

  // External query state for EntryList
  const externalQueryState: ExternalQueryState = {
    isLoading: isLoading && !isReady,
    isError: false,
    errorMessage: undefined,
    isFetchingNextPage,
    hasNextPage,
    fetchNextPage,
    refetch: () => utils.entries.list.invalidate(),
  };

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
      externalEntries={stableEntries}
      externalQueryState={externalQueryState}
      emptyMessage={emptyMessage}
    />
  );
}

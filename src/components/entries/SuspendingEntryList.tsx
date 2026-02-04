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

import { useMemo, useCallback } from "react";
import { trpc } from "@/lib/trpc/client";
import { useEntryMutations } from "@/lib/hooks";
import { useEntryUrlState } from "@/lib/hooks/useEntryUrlState";
import { useKeyboardShortcutsContext } from "@/components/keyboard";
import { useKeyboardShortcuts } from "@/lib/hooks/useKeyboardShortcuts";
import { useUrlViewPreferences } from "@/lib/hooks/useUrlViewPreferences";
import { useEntriesListInput } from "@/lib/hooks/useEntriesListInput";
import { EntryList, type ExternalQueryState } from "./EntryList";

interface SuspendingEntryListProps {
  emptyMessage: string;
}

export function SuspendingEntryList({ emptyMessage }: SuspendingEntryListProps) {
  const { openEntryId, setOpenEntryId } = useEntryUrlState();
  const { showUnreadOnly, sortOrder, toggleShowUnreadOnly } = useUrlViewPreferences();
  const { enabled: keyboardShortcutsEnabled } = useKeyboardShortcutsContext();
  const utils = trpc.useUtils();

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
    onNavigateNext: undefined, // Navigation handled by EntryContent
    onNavigatePrevious: undefined,
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

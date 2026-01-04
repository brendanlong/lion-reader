/**
 * All Entries Page
 *
 * Displays all entries from subscribed feeds in a unified timeline.
 * This is the main view after logging in.
 */

"use client";

import { Suspense, useCallback, useMemo } from "react";
import {
  EntryList,
  EntryContent,
  UnreadToggle,
  SortToggle,
  type ExternalQueryState,
} from "@/components/entries";
import { MarkAllReadDialog } from "@/components/feeds/MarkAllReadDialog";
import { useKeyboardShortcutsContext } from "@/components/keyboard";
import {
  useKeyboardShortcuts,
  useViewPreferences,
  useEntryMutations,
  useEntryUrlState,
  useEntryListQuery,
} from "@/lib/hooks";
import { trpc } from "@/lib/trpc/client";
import { useState } from "react";

function AllEntriesContent() {
  const { openEntryId, setOpenEntryId, closeEntry } = useEntryUrlState();
  const [showMarkAllReadDialog, setShowMarkAllReadDialog] = useState(false);

  const { enabled: keyboardShortcutsEnabled } = useKeyboardShortcutsContext();
  const { showUnreadOnly, toggleShowUnreadOnly, sortOrder, toggleSortOrder } =
    useViewPreferences("all");
  const utils = trpc.useUtils();

  // Use entry list query that stays mounted while viewing entries
  // This enables seamless swiping beyond initially loaded entries
  const entryListQuery = useEntryListQuery({
    filters: { unreadOnly: showUnreadOnly, sortOrder },
    openEntryId,
  });

  // Get total unread count from subscriptions
  const subscriptionsQuery = trpc.subscriptions.list.useQuery();
  const totalUnreadCount =
    subscriptionsQuery.data?.items.reduce((sum, item) => sum + item.subscription.unreadCount, 0) ??
    0;

  // Entry mutations with optimistic updates
  const { toggleRead, toggleStar, markAllRead, isMarkAllReadPending } = useEntryMutations({
    listFilters: { unreadOnly: showUnreadOnly, sortOrder },
  });

  const handleMarkAllRead = useCallback(() => {
    markAllRead({});
    setShowMarkAllReadDialog(false);
  }, [markAllRead]);

  // Keyboard navigation and actions (also provides swipe navigation functions)
  const { selectedEntryId, setSelectedEntryId, goToNextEntry, goToPreviousEntry } =
    useKeyboardShortcuts({
      entries: entryListQuery.entries,
      onOpenEntry: setOpenEntryId,
      onClose: closeEntry,
      isEntryOpen: !!openEntryId,
      enabled: keyboardShortcutsEnabled,
      onToggleRead: toggleRead,
      onToggleStar: toggleStar,
      onRefresh: () => {
        utils.entries.list.invalidate();
      },
      onToggleUnreadOnly: toggleShowUnreadOnly,
    });

  const handleEntryClick = useCallback(
    (entryId: string) => {
      setSelectedEntryId(entryId);
      setOpenEntryId(entryId);
    },
    [setSelectedEntryId, setOpenEntryId]
  );

  const handleBack = useCallback(() => {
    closeEntry();
  }, [closeEntry]);

  // Build external query state for EntryList
  const externalQueryState: ExternalQueryState = useMemo(
    () => ({
      isLoading: entryListQuery.isLoading,
      isError: entryListQuery.isError,
      errorMessage: entryListQuery.errorMessage,
      isFetchingNextPage: entryListQuery.isFetchingNextPage,
      hasNextPage: entryListQuery.hasNextPage,
      fetchNextPage: entryListQuery.fetchNextPage,
      refetch: entryListQuery.refetch,
      prefetchEntry: entryListQuery.prefetchEntry,
    }),
    [entryListQuery]
  );

  // If an entry is open, show the full content view
  // Key forces remount when entryId changes, ensuring fresh refs and mutation state
  if (openEntryId) {
    return (
      <EntryContent
        key={openEntryId}
        entryId={openEntryId}
        listFilters={{ unreadOnly: showUnreadOnly, sortOrder }}
        onBack={handleBack}
        onSwipeNext={goToNextEntry}
        onSwipePrevious={goToPreviousEntry}
        nextEntryId={entryListQuery.nextEntryId}
        previousEntryId={entryListQuery.previousEntryId}
      />
    );
  }

  // Otherwise, show the entry list
  return (
    <div className="mx-auto max-w-3xl px-4 py-4 sm:p-6">
      <div className="mb-4 flex items-center justify-between sm:mb-6">
        <h1 className="text-xl font-bold text-zinc-900 sm:text-2xl dark:text-zinc-50">All Items</h1>
        <div className="flex gap-2">
          {totalUnreadCount > 0 && (
            <button
              type="button"
              onClick={() => setShowMarkAllReadDialog(true)}
              className="inline-flex items-center justify-center rounded-md p-2 text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-700 focus:ring-2 focus:ring-zinc-500 focus:ring-offset-2 focus:outline-none dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200 dark:focus:ring-zinc-400"
              title="Mark all as read"
              aria-label="Mark all as read"
            >
              <svg
                className="h-5 w-5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={1.5}
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                />
              </svg>
              <span className="ml-1.5 hidden text-sm sm:inline">Mark All Read</span>
            </button>
          )}
          <SortToggle sortOrder={sortOrder} onToggle={toggleSortOrder} />
          <UnreadToggle showUnreadOnly={showUnreadOnly} onToggle={toggleShowUnreadOnly} />
        </div>
      </div>

      <EntryList
        filters={{ unreadOnly: showUnreadOnly, sortOrder }}
        onEntryClick={handleEntryClick}
        selectedEntryId={selectedEntryId}
        onToggleRead={toggleRead}
        onToggleStar={toggleStar}
        externalEntries={entryListQuery.entries}
        externalQueryState={externalQueryState}
        emptyMessage={
          showUnreadOnly
            ? "No unread entries. Toggle to show all items."
            : "No entries yet. Subscribe to some feeds to see entries here."
        }
      />

      <MarkAllReadDialog
        isOpen={showMarkAllReadDialog}
        contextDescription="all feeds"
        unreadCount={totalUnreadCount}
        isLoading={isMarkAllReadPending}
        onConfirm={handleMarkAllRead}
        onCancel={() => setShowMarkAllReadDialog(false)}
      />
    </div>
  );
}

export default function AllEntriesPage() {
  return (
    <Suspense>
      <AllEntriesContent />
    </Suspense>
  );
}

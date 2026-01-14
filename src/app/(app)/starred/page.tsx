/**
 * Starred Entries Client Component
 *
 * Client-side component for the Starred Entries page.
 * Contains all the interactive logic for displaying and managing starred entries.
 */

"use client";

import { Suspense, useState, useCallback, useMemo } from "react";
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
  useUrlViewPreferences,
  useEntryMutations,
  useEntryUrlState,
  useEntryListQuery,
} from "@/lib/hooks";
import { trpc } from "@/lib/trpc/client";

function StarredEntriesContent() {
  const { openEntryId, setOpenEntryId, closeEntry } = useEntryUrlState();
  const [showMarkAllReadDialog, setShowMarkAllReadDialog] = useState(false);

  const { enabled: keyboardShortcutsEnabled } = useKeyboardShortcutsContext();
  const { showUnreadOnly, toggleShowUnreadOnly, sortOrder, toggleSortOrder } =
    useUrlViewPreferences("starred");
  const utils = trpc.useUtils();

  // Use entry list query that stays mounted while viewing entries
  const entryListQuery = useEntryListQuery({
    filters: { starredOnly: true, unreadOnly: showUnreadOnly, sortOrder },
    openEntryId,
  });

  // Get starred entries count (total and unread)
  const starredCountQuery = trpc.entries.count.useQuery({ starredOnly: true });
  const unreadStarredCount = starredCountQuery.data?.unread ?? 0;

  // Get subscriptions to look up tags for entries
  const subscriptionsQuery = trpc.subscriptions.list.useQuery();

  // Entry mutations with optimistic updates
  const { toggleRead, toggleStar, markAllRead, isMarkAllReadPending } = useEntryMutations({
    listFilters: { starredOnly: true, unreadOnly: showUnreadOnly, sortOrder },
  });

  // Wrapper to look up tags and pass entryType + subscriptionId + tagIds to mutations
  const handleToggleRead = useCallback(
    (
      entryId: string,
      currentlyRead: boolean,
      entryType: "web" | "email" | "saved",
      subscriptionId: string | null
    ) => {
      if (!subscriptionId) {
        toggleRead(entryId, currentlyRead, entryType);
        return;
      }
      // Look up tags for this subscription
      const subscription = subscriptionsQuery.data?.items.find((sub) => sub.id === subscriptionId);
      const tagIds = subscription?.tags.map((tag) => tag.id);
      toggleRead(entryId, currentlyRead, entryType, subscriptionId, tagIds);
    },
    [toggleRead, subscriptionsQuery.data]
  );

  const handleMarkAllRead = useCallback(() => {
    markAllRead({ starredOnly: true });
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
      onToggleRead: handleToggleRead,
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
    }),
    [entryListQuery]
  );

  // Render both list and content, hiding the list when viewing an entry.
  // This preserves scroll position and enables seamless j/k navigation.
  return (
    <>
      {/* Entry content - only rendered when an entry is open */}
      {openEntryId && (
        <EntryContent
          key={openEntryId}
          entryId={openEntryId}
          listFilters={{ starredOnly: true, unreadOnly: showUnreadOnly, sortOrder }}
          onBack={handleBack}
          onSwipeNext={goToNextEntry}
          onSwipePrevious={goToPreviousEntry}
          nextEntryId={entryListQuery.nextEntryId}
          previousEntryId={entryListQuery.previousEntryId}
        />
      )}

      {/* Entry list - always mounted but hidden when viewing an entry */}
      <div className={`mx-auto max-w-3xl px-4 py-4 sm:p-6 ${openEntryId ? "hidden" : ""}`}>
        <div className="mb-4 flex items-center justify-between sm:mb-6">
          <h1 className="text-xl font-bold text-zinc-900 sm:text-2xl dark:text-zinc-50">Starred</h1>
          <div className="flex gap-2">
            {unreadStarredCount > 0 && (
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
          filters={{ starredOnly: true, unreadOnly: showUnreadOnly, sortOrder }}
          onEntryClick={handleEntryClick}
          selectedEntryId={selectedEntryId}
          onToggleRead={handleToggleRead}
          onToggleStar={toggleStar}
          externalEntries={entryListQuery.entries}
          externalQueryState={externalQueryState}
          emptyMessage={
            showUnreadOnly
              ? "No unread starred entries. Toggle to show all starred items."
              : "No starred entries yet. Star entries to save them for later."
          }
        />

        <MarkAllReadDialog
          isOpen={showMarkAllReadDialog}
          contextDescription="starred entries"
          unreadCount={unreadStarredCount}
          isLoading={isMarkAllReadPending}
          onConfirm={handleMarkAllRead}
          onCancel={() => setShowMarkAllReadDialog(false)}
        />
      </div>
    </>
  );
}

export default function StarredEntriesPage() {
  return (
    <Suspense>
      <StarredEntriesContent />
    </Suspense>
  );
}

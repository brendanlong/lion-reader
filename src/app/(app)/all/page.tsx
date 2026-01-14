/**
 * All Entries Client Component
 *
 * Client-side component for the All Entries page.
 * Contains all the interactive logic for displaying and managing entries.
 */

"use client";

import { Suspense, useCallback, useMemo, useState, useSyncExternalStore } from "react";
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
  useMergedEntries,
} from "@/lib/hooks";
import { trpc } from "@/lib/trpc/client";

function AllEntriesContent() {
  const { openEntryId, setOpenEntryId, closeEntry } = useEntryUrlState();
  const [showMarkAllReadDialog, setShowMarkAllReadDialog] = useState(false);

  // Returns true on client, false on server - for avoiding hydration mismatches with conditional rendering
  const isClient = useSyncExternalStore(
    () => () => {}, // No-op subscribe since value never changes
    () => true, // Client snapshot
    () => false // Server snapshot
  );

  const { enabled: keyboardShortcutsEnabled } = useKeyboardShortcutsContext();
  const { showUnreadOnly, toggleShowUnreadOnly, sortOrder, toggleSortOrder } =
    useUrlViewPreferences("all");
  const utils = trpc.useUtils();

  // Use entry list query that stays mounted while viewing entries
  // This enables seamless swiping beyond initially loaded entries
  const entryListQuery = useEntryListQuery({
    filters: { unreadOnly: showUnreadOnly, sortOrder },
    openEntryId,
  });

  // Merge entries with Zustand deltas for consistent state across components
  // This ensures keyboard shortcuts see the same read/starred state as the list
  const mergedEntries = useMergedEntries(entryListQuery.entries, {
    unreadOnly: showUnreadOnly,
  });

  // Get total unread count from subscriptions
  const subscriptionsQuery = trpc.subscriptions.list.useQuery();
  const totalUnreadCount =
    subscriptionsQuery.data?.items.reduce((sum, item) => sum + item.unreadCount, 0) ?? 0;

  // Entry mutations with optimistic updates
  const { toggleRead, toggleStar, markAllRead, isMarkAllReadPending } = useEntryMutations({
    listFilters: { unreadOnly: showUnreadOnly, sortOrder },
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
        // No subscription - saved article or starred entry from deleted subscription
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
    markAllRead({});
    setShowMarkAllReadDialog(false);
  }, [markAllRead]);

  // Keyboard navigation and actions (also provides swipe navigation functions)
  // Uses merged entries so keyboard shortcuts see the same state as the list
  const { selectedEntryId, setSelectedEntryId, goToNextEntry, goToPreviousEntry } =
    useKeyboardShortcuts({
      entries: mergedEntries,
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
          listFilters={{ unreadOnly: showUnreadOnly, sortOrder }}
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
          <h1 className="text-xl font-bold text-zinc-900 sm:text-2xl dark:text-zinc-50">
            All Items
          </h1>
          <div className="flex gap-2">
            {/* Only render on client to avoid SSR/client hydration mismatch */}
            {isClient && totalUnreadCount > 0 && (
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
          onToggleRead={handleToggleRead}
          onToggleStar={toggleStar}
          externalEntries={mergedEntries}
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
    </>
  );
}

export default function AllEntriesPage() {
  return (
    <Suspense>
      <AllEntriesContent />
    </Suspense>
  );
}

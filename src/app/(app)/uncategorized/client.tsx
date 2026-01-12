/**
 * Uncategorized Entries Client Component
 *
 * Client-side component for the Uncategorized Entries page.
 * Contains all the interactive logic for displaying and managing uncategorized entries.
 */

"use client";

import { Suspense, useState, useCallback, useMemo } from "react";
import Link from "next/link";
import { trpc } from "@/lib/trpc/client";
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

function UncategorizedEntriesContent() {
  const { openEntryId, setOpenEntryId, closeEntry } = useEntryUrlState();
  const [showMarkAllReadDialog, setShowMarkAllReadDialog] = useState(false);

  const { enabled: keyboardShortcutsEnabled } = useKeyboardShortcutsContext();
  const { showUnreadOnly, toggleShowUnreadOnly, sortOrder, toggleSortOrder } =
    useUrlViewPreferences("uncategorized");
  const utils = trpc.useUtils();

  // Use entry list query that stays mounted while viewing entries
  const entryListQuery = useEntryListQuery({
    filters: { uncategorized: true, unreadOnly: showUnreadOnly, sortOrder },
    openEntryId,
  });

  // Entry mutations with optimistic updates
  const { toggleRead, toggleStar, markAllRead, isMarkAllReadPending } = useEntryMutations({
    listFilters: { uncategorized: true, unreadOnly: showUnreadOnly, sortOrder },
  });

  const handleMarkAllRead = useCallback(() => {
    markAllRead({ uncategorized: true });
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

  // Fetch subscriptions to compute feed count and unread count
  const subscriptionsQuery = trpc.subscriptions.list.useQuery();

  const uncategorizedFeeds = useMemo(() => {
    return subscriptionsQuery.data?.items.filter((item) => item.tags.length === 0) ?? [];
  }, [subscriptionsQuery.data?.items]);

  const feedCount = uncategorizedFeeds.length;
  const unreadCount = useMemo(() => {
    return uncategorizedFeeds.reduce((sum, item) => sum + item.unreadCount, 0);
  }, [uncategorizedFeeds]);

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

  // Show loading state while checking subscriptions
  if (subscriptionsQuery.isLoading) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-4 sm:p-6">
        <div className="mb-6 animate-pulse">
          <div className="mb-2 h-8 w-48 rounded bg-zinc-200 dark:bg-zinc-700" />
          <div className="h-4 w-32 rounded bg-zinc-200 dark:bg-zinc-700" />
        </div>
      </div>
    );
  }

  // Render both list and content, hiding the list when viewing an entry.
  // This preserves scroll position and enables seamless j/k navigation.
  return (
    <>
      {/* Entry content - only rendered when an entry is open */}
      {openEntryId && (
        <EntryContent
          key={openEntryId}
          entryId={openEntryId}
          listFilters={{ uncategorized: true, unreadOnly: showUnreadOnly, sortOrder }}
          onBack={handleBack}
          onSwipeNext={goToNextEntry}
          onSwipePrevious={goToPreviousEntry}
          nextEntryId={entryListQuery.nextEntryId}
          previousEntryId={entryListQuery.previousEntryId}
        />
      )}

      {/* Entry list - always mounted but hidden when viewing an entry */}
      <div className={`mx-auto max-w-3xl px-4 py-4 sm:p-6 ${openEntryId ? "hidden" : ""}`}>
        <div className="mb-4 sm:mb-6">
          {/* Breadcrumb back link */}
          <Link
            href="/all"
            className="mb-2 -ml-2 inline-flex min-h-[36px] items-center rounded-md px-2 text-sm text-zinc-500 hover:bg-zinc-100 hover:text-zinc-700 active:bg-zinc-200 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200 dark:active:bg-zinc-700"
          >
            <svg className="mr-1 h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M10 19l-7-7m0 0l7-7m-7 7h18"
              />
            </svg>
            All Items
          </Link>

          {/* Uncategorized header with gray color dot */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <span
                className="inline-block h-4 w-4 rounded-full"
                style={{ backgroundColor: "#6b7280" }}
                aria-hidden="true"
              />
              <h1 className="text-xl font-bold text-zinc-900 sm:text-2xl dark:text-zinc-50">
                Uncategorized
              </h1>
              {feedCount > 0 && (
                <span className="rounded-full bg-zinc-100 px-2.5 py-0.5 text-sm text-zinc-600 sm:px-3 sm:py-1 dark:bg-zinc-800 dark:text-zinc-400">
                  {feedCount} feed{feedCount !== 1 ? "s" : ""}
                </span>
              )}
            </div>
            <div className="flex gap-2">
              {unreadCount > 0 && (
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
        </div>

        <EntryList
          filters={{ uncategorized: true, unreadOnly: showUnreadOnly, sortOrder }}
          onEntryClick={handleEntryClick}
          selectedEntryId={selectedEntryId}
          onToggleRead={toggleRead}
          onToggleStar={toggleStar}
          externalEntries={entryListQuery.entries}
          externalQueryState={externalQueryState}
          emptyMessage={
            showUnreadOnly
              ? "No unread entries from uncategorized feeds. Toggle to show all items."
              : "No entries from uncategorized feeds yet."
          }
        />

        <MarkAllReadDialog
          isOpen={showMarkAllReadDialog}
          contextDescription="uncategorized feeds"
          unreadCount={unreadCount}
          isLoading={isMarkAllReadPending}
          onConfirm={handleMarkAllRead}
          onCancel={() => setShowMarkAllReadDialog(false)}
        />
      </div>
    </>
  );
}

export function UncategorizedEntriesClient() {
  return (
    <Suspense>
      <UncategorizedEntriesContent />
    </Suspense>
  );
}

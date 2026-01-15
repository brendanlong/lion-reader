/**
 * Starred Entries Page
 *
 * Displays all starred entries.
 */

"use client";

import { Suspense, useState } from "react";
import { EntryList, EntryContent, UnreadToggle, SortToggle } from "@/components/entries";
import { MarkAllReadDialog } from "@/components/feeds/MarkAllReadDialog";
import { useEntryPage } from "@/lib/hooks";
import { trpc } from "@/lib/trpc/client";

function StarredEntriesContent() {
  const [showMarkAllReadDialog, setShowMarkAllReadDialog] = useState(false);

  const page = useEntryPage({
    viewId: "starred",
    filters: { starredOnly: true },
  });

  // Get starred entries count
  const starredCountQuery = trpc.entries.count.useQuery({ starredOnly: true });
  const unreadStarredCount = starredCountQuery.data?.unread ?? 0;

  return (
    <>
      {page.entryContentProps && (
        <EntryContent key={page.entryContentProps.entryId} {...page.entryContentProps} />
      )}

      <div className={`mx-auto max-w-3xl px-4 py-4 sm:p-6 ${page.openEntryId ? "hidden" : ""}`}>
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
            <SortToggle sortOrder={page.sortOrder} onToggle={page.toggleSortOrder} />
            <UnreadToggle
              showUnreadOnly={page.showUnreadOnly}
              onToggle={page.toggleShowUnreadOnly}
            />
          </div>
        </div>

        <EntryList
          {...page.entryListProps}
          emptyMessage={
            page.showUnreadOnly
              ? "No unread starred entries. Toggle to show all starred items."
              : "No starred entries yet. Star entries to save them for later."
          }
        />

        <MarkAllReadDialog
          isOpen={showMarkAllReadDialog}
          contextDescription="starred entries"
          unreadCount={unreadStarredCount}
          isLoading={page.isMarkAllReadPending}
          onConfirm={() => {
            page.handleMarkAllRead({ starredOnly: true });
            setShowMarkAllReadDialog(false);
          }}
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

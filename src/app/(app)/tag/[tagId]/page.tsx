/**
 * Tag Entries Page
 *
 * Displays entries from feeds that have a specific tag.
 */

"use client";

import { Suspense, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { trpc } from "@/lib/trpc/client";
import {
  EntryList,
  EntryContent,
  UnreadToggle,
  SortToggle,
  type EntryListEntryData,
} from "@/components/entries";
import { useKeyboardShortcutsContext } from "@/components/keyboard";
import {
  useKeyboardShortcuts,
  useViewPreferences,
  useEntryMutations,
  useEntryUrlState,
  type KeyboardEntryData,
} from "@/lib/hooks";

/**
 * Loading skeleton for the tag header.
 */
function TagHeaderSkeleton() {
  return (
    <div className="mb-6 animate-pulse">
      <div className="mb-2 h-8 w-48 rounded bg-zinc-200 dark:bg-zinc-700" />
      <div className="h-4 w-32 rounded bg-zinc-200 dark:bg-zinc-700" />
    </div>
  );
}

/**
 * Error state for when the tag is not found.
 */
function TagNotFound() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-4 sm:p-6">
      <div className="rounded-lg border border-zinc-200 bg-white p-6 text-center sm:p-8 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-red-100 dark:bg-red-900/20">
          <svg
            className="h-6 w-6 text-red-500 dark:text-red-400"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
            />
          </svg>
        </div>
        <h2 className="mb-2 text-lg font-medium text-zinc-900 dark:text-zinc-50">Tag not found</h2>
        <p className="mb-4 text-sm text-zinc-600 dark:text-zinc-400">
          The tag you&apos;re looking for doesn&apos;t exist.
        </p>
        <Link
          href="/all"
          className="inline-flex items-center text-sm font-medium text-zinc-900 hover:underline dark:text-zinc-50"
        >
          <svg className="mr-2 h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M10 19l-7-7m0 0l7-7m-7 7h18"
            />
          </svg>
          Back to All Items
        </Link>
      </div>
    </div>
  );
}

function TagEntriesContent() {
  const params = useParams<{ tagId: string }>();
  const tagId = params.tagId;

  const { openEntryId, setOpenEntryId, closeEntry } = useEntryUrlState();
  const [entries, setEntries] = useState<KeyboardEntryData[]>([]);

  const { enabled: keyboardShortcutsEnabled } = useKeyboardShortcutsContext();
  const { showUnreadOnly, toggleShowUnreadOnly, sortOrder, toggleSortOrder } = useViewPreferences(
    "tag",
    tagId
  );
  const utils = trpc.useUtils();

  // Entry mutations with optimistic updates
  const { toggleRead, toggleStar } = useEntryMutations({
    listFilters: { tagId, unreadOnly: showUnreadOnly, sortOrder },
  });

  // Keyboard navigation and actions
  const { selectedEntryId, setSelectedEntryId } = useKeyboardShortcuts({
    entries,
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

  // Fetch tag info
  const tagsQuery = trpc.tags.list.useQuery();

  // Find the tag
  const tag = tagsQuery.data?.items.find((t) => t.id === tagId);

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

  const handleEntriesLoaded = useCallback((loadedEntries: EntryListEntryData[]) => {
    setEntries(loadedEntries);
  }, []);

  // Handler to toggle read status (passed to EntryContent)
  const handleToggleRead = useCallback(
    (entryId: string, currentlyRead: boolean) => {
      toggleRead(entryId, currentlyRead);
    },
    [toggleRead]
  );

  // If an entry is open, show the full content view
  if (openEntryId) {
    return (
      <EntryContent entryId={openEntryId} onBack={handleBack} onToggleRead={handleToggleRead} />
    );
  }

  // Show loading state while checking tag
  if (tagsQuery.isLoading) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-4 sm:p-6">
        <TagHeaderSkeleton />
      </div>
    );
  }

  // Show error if tag not found
  if (!tag) {
    return <TagNotFound />;
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-4 sm:p-6">
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

        {/* Tag header with color dot */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span
              className="inline-block h-4 w-4 rounded-full"
              style={{ backgroundColor: tag.color || "#6b7280" }}
              aria-hidden="true"
            />
            <h1 className="text-xl font-bold text-zinc-900 sm:text-2xl dark:text-zinc-50">
              {tag.name}
            </h1>
            {tag.feedCount > 0 && (
              <span className="rounded-full bg-zinc-100 px-2.5 py-0.5 text-sm text-zinc-600 sm:px-3 sm:py-1 dark:bg-zinc-800 dark:text-zinc-400">
                {tag.feedCount} feed{tag.feedCount !== 1 ? "s" : ""}
              </span>
            )}
          </div>
          <div className="flex gap-2">
            <SortToggle sortOrder={sortOrder} onToggle={toggleSortOrder} />
            <UnreadToggle showUnreadOnly={showUnreadOnly} onToggle={toggleShowUnreadOnly} />
          </div>
        </div>
      </div>

      <EntryList
        filters={{ tagId, unreadOnly: showUnreadOnly, sortOrder }}
        onEntryClick={handleEntryClick}
        selectedEntryId={selectedEntryId}
        onEntriesLoaded={handleEntriesLoaded}
        emptyMessage={
          showUnreadOnly
            ? `No unread entries from feeds tagged with "${tag.name}". Toggle to show all items.`
            : `No entries from feeds tagged with "${tag.name}" yet.`
        }
      />
    </div>
  );
}

export default function TagEntriesPage() {
  return (
    <Suspense>
      <TagEntriesContent />
    </Suspense>
  );
}

/**
 * All Entries Page
 *
 * Displays all entries from subscribed feeds in a unified timeline.
 * This is the main view after logging in.
 */

"use client";

import { Suspense, useState, useCallback } from "react";
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
import { trpc } from "@/lib/trpc/client";

function AllEntriesContent() {
  const { openEntryId, setOpenEntryId, closeEntry } = useEntryUrlState();
  const [entries, setEntries] = useState<KeyboardEntryData[]>([]);

  const { enabled: keyboardShortcutsEnabled } = useKeyboardShortcutsContext();
  const { showUnreadOnly, toggleShowUnreadOnly, sortOrder, toggleSortOrder } =
    useViewPreferences("all");
  const utils = trpc.useUtils();

  // Entry mutations with optimistic updates
  const { toggleRead, toggleStar } = useEntryMutations({
    listFilters: { unreadOnly: showUnreadOnly, sortOrder },
  });

  // Keyboard navigation and actions (also provides swipe navigation functions)
  const { selectedEntryId, setSelectedEntryId, goToNextEntry, goToPreviousEntry } =
    useKeyboardShortcuts({
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

  // If an entry is open, show the full content view
  // Key forces remount when entryId changes, ensuring fresh refs and mutation state
  if (openEntryId) {
    return (
      <EntryContent
        key={openEntryId}
        entryId={openEntryId}
        onBack={handleBack}
        onSwipeNext={goToNextEntry}
        onSwipePrevious={goToPreviousEntry}
      />
    );
  }

  // Otherwise, show the entry list
  return (
    <div className="mx-auto max-w-3xl px-4 py-4 sm:p-6">
      <div className="mb-4 flex items-center justify-between sm:mb-6">
        <h1 className="text-xl font-bold text-zinc-900 sm:text-2xl dark:text-zinc-50">All Items</h1>
        <div className="flex gap-2">
          <SortToggle sortOrder={sortOrder} onToggle={toggleSortOrder} />
          <UnreadToggle showUnreadOnly={showUnreadOnly} onToggle={toggleShowUnreadOnly} />
        </div>
      </div>

      <EntryList
        filters={{ unreadOnly: showUnreadOnly, sortOrder }}
        onEntryClick={handleEntryClick}
        selectedEntryId={selectedEntryId}
        onEntriesLoaded={handleEntriesLoaded}
        onToggleRead={toggleRead}
        onToggleStar={toggleStar}
        emptyMessage={
          showUnreadOnly
            ? "No unread entries. Toggle to show all items."
            : "No entries yet. Subscribe to some feeds to see entries here."
        }
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

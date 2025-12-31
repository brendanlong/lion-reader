/**
 * Starred Entries Page
 *
 * Displays entries that the user has starred for later reading.
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

function StarredEntriesContent() {
  const { openEntryId, setOpenEntryId, closeEntry } = useEntryUrlState();
  const [entries, setEntries] = useState<KeyboardEntryData[]>([]);

  const { enabled: keyboardShortcutsEnabled } = useKeyboardShortcutsContext();
  const { showUnreadOnly, toggleShowUnreadOnly, sortOrder, toggleSortOrder } =
    useViewPreferences("starred");
  const utils = trpc.useUtils();

  // Entry mutations with optimistic updates
  const { toggleRead, toggleStar } = useEntryMutations({
    listFilters: { starredOnly: true, unreadOnly: showUnreadOnly, sortOrder },
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
    return <EntryContent key={openEntryId} entryId={openEntryId} onBack={handleBack} />;
  }

  // Otherwise, show the starred entries list
  return (
    <div className="mx-auto max-w-3xl px-4 py-4 sm:p-6">
      <div className="mb-4 flex items-center justify-between sm:mb-6">
        <h1 className="text-xl font-bold text-zinc-900 sm:text-2xl dark:text-zinc-50">Starred</h1>
        <div className="flex gap-2">
          <SortToggle sortOrder={sortOrder} onToggle={toggleSortOrder} />
          <UnreadToggle showUnreadOnly={showUnreadOnly} onToggle={toggleShowUnreadOnly} />
        </div>
      </div>

      <EntryList
        filters={{ starredOnly: true, unreadOnly: showUnreadOnly, sortOrder }}
        onEntryClick={handleEntryClick}
        selectedEntryId={selectedEntryId}
        onEntriesLoaded={handleEntriesLoaded}
        onToggleRead={toggleRead}
        onToggleStar={toggleStar}
        emptyMessage={
          showUnreadOnly
            ? "No unread starred entries. Toggle to show all starred items."
            : "No starred entries yet. Star entries to save them for later."
        }
      />
    </div>
  );
}

export default function StarredEntriesPage() {
  return (
    <Suspense>
      <StarredEntriesContent />
    </Suspense>
  );
}

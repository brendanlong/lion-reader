/**
 * Starred Entries Page
 *
 * Displays entries that the user has starred for later reading.
 */

"use client";

import { useState, useCallback } from "react";
import { EntryList } from "@/components/entries/EntryList";
import { EntryContent } from "@/components/entries/EntryContent";
import { useKeyboardShortcuts } from "@/lib/hooks";

export default function StarredEntriesPage() {
  const [openEntryId, setOpenEntryId] = useState<string | null>(null);
  const [entryIds, setEntryIds] = useState<string[]>([]);

  // Keyboard navigation
  const { selectedEntryId, setSelectedEntryId } = useKeyboardShortcuts({
    entryIds,
    onOpenEntry: (entryId) => setOpenEntryId(entryId),
    onClose: () => setOpenEntryId(null),
    isEntryOpen: !!openEntryId,
  });

  const handleEntryClick = useCallback(
    (entryId: string) => {
      setSelectedEntryId(entryId);
      setOpenEntryId(entryId);
    },
    [setSelectedEntryId]
  );

  const handleBack = useCallback(() => {
    setOpenEntryId(null);
  }, []);

  const handleEntriesLoaded = useCallback((ids: string[]) => {
    setEntryIds(ids);
  }, []);

  // If an entry is open, show the full content view
  if (openEntryId) {
    return <EntryContent entryId={openEntryId} onBack={handleBack} />;
  }

  // Otherwise, show the starred entries list
  return (
    <div className="mx-auto max-w-3xl px-4 py-4 sm:p-6">
      <div className="mb-4 flex items-center justify-between sm:mb-6">
        <h1 className="text-xl font-bold text-zinc-900 sm:text-2xl dark:text-zinc-50">Starred</h1>
      </div>

      <EntryList
        filters={{ starredOnly: true }}
        onEntryClick={handleEntryClick}
        selectedEntryId={selectedEntryId}
        onEntriesLoaded={handleEntriesLoaded}
        emptyMessage="No starred entries yet. Star entries to save them for later."
      />
    </div>
  );
}

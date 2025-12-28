/**
 * Starred Entries Page
 *
 * Displays entries that the user has starred for later reading.
 */

"use client";

import { useState, useCallback } from "react";
import { EntryList, type EntryListEntryData } from "@/components/entries/EntryList";
import { EntryContent } from "@/components/entries/EntryContent";
import { useKeyboardShortcutsContext } from "@/components/keyboard";
import { useKeyboardShortcuts, type KeyboardEntryData } from "@/lib/hooks";
import { trpc } from "@/lib/trpc/client";

export default function StarredEntriesPage() {
  const [openEntryId, setOpenEntryId] = useState<string | null>(null);
  const [entries, setEntries] = useState<KeyboardEntryData[]>([]);

  const { enabled: keyboardShortcutsEnabled } = useKeyboardShortcutsContext();
  const utils = trpc.useUtils();

  // Mutations for keyboard actions
  const markReadMutation = trpc.entries.markRead.useMutation({
    onSuccess: () => {
      utils.entries.list.invalidate();
      utils.subscriptions.list.invalidate();
    },
  });

  const starMutation = trpc.entries.star.useMutation({
    onSuccess: () => {
      utils.entries.list.invalidate();
    },
  });

  const unstarMutation = trpc.entries.unstar.useMutation({
    onSuccess: () => {
      utils.entries.list.invalidate();
    },
  });

  // Keyboard navigation and actions
  const { selectedEntryId, setSelectedEntryId } = useKeyboardShortcuts({
    entries,
    onOpenEntry: (entryId) => setOpenEntryId(entryId),
    onClose: () => setOpenEntryId(null),
    isEntryOpen: !!openEntryId,
    enabled: keyboardShortcutsEnabled,
    onToggleRead: (entryId, currentlyRead) => {
      markReadMutation.mutate({ ids: [entryId], read: !currentlyRead });
    },
    onToggleStar: (entryId, currentlyStarred) => {
      if (currentlyStarred) {
        unstarMutation.mutate({ id: entryId });
      } else {
        starMutation.mutate({ id: entryId });
      }
    },
    onRefresh: () => {
      utils.entries.list.invalidate();
    },
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

  const handleEntriesLoaded = useCallback((loadedEntries: EntryListEntryData[]) => {
    setEntries(loadedEntries);
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

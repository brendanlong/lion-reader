/**
 * Starred Entries Page
 *
 * Displays entries that the user has starred for later reading.
 */

"use client";

import { useState } from "react";
import { EntryList } from "@/components/entries/EntryList";
import { EntryContent } from "@/components/entries/EntryContent";

export default function StarredEntriesPage() {
  const [selectedEntryId, setSelectedEntryId] = useState<string | null>(null);

  const handleEntryClick = (entryId: string) => {
    setSelectedEntryId(entryId);
  };

  const handleBack = () => {
    setSelectedEntryId(null);
  };

  // If an entry is selected, show the full content view
  if (selectedEntryId) {
    return <EntryContent entryId={selectedEntryId} onBack={handleBack} />;
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
        emptyMessage="No starred entries yet. Star entries to save them for later."
      />
    </div>
  );
}

/**
 * All Entries Page
 *
 * Displays all entries from subscribed feeds in a unified timeline.
 * This is the main view after logging in.
 */

"use client";

import { useState } from "react";
import { EntryList } from "@/components/entries/EntryList";
import { EntryContent } from "@/components/entries/EntryContent";

export default function AllEntriesPage() {
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

  // Otherwise, show the entry list
  return (
    <div className="mx-auto max-w-3xl p-6">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-50">All Items</h1>
      </div>

      <EntryList
        onEntryClick={handleEntryClick}
        emptyMessage="No entries yet. Subscribe to some feeds to see entries here."
      />
    </div>
  );
}

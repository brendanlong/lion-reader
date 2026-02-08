/**
 * DemoEntryList Component
 *
 * Thin wrapper around EntryList for the demo page.
 * Uses static data and navigates via clientPush on entry click.
 * Passes toggle handlers from DemoStateContext for interactive read/starred state.
 */

"use client";

import { useCallback } from "react";
import { EntryList, type ExternalQueryState } from "@/components/entries/EntryList";
import { clientPush } from "@/lib/navigation";
import { type DemoEntry } from "./data";
import { useDemoState } from "./DemoStateContext";

// Static query state for the demo - no fetching, all data loaded
const STATIC_QUERY_STATE: ExternalQueryState = {
  isLoading: false,
  isError: false,
  isFetchingNextPage: false,
  hasNextPage: false,
  fetchNextPage: () => {},
  refetch: () => {},
};

interface DemoEntryListProps {
  entries: DemoEntry[];
  backHref: string;
  selectedEntryId?: string | null;
}

export function DemoEntryList({ entries, backHref, selectedEntryId }: DemoEntryListProps) {
  const demoState = useDemoState();

  const handleToggleRead = useCallback(
    (entryId: string) => {
      demoState.toggleRead(entryId);
    },
    [demoState]
  );

  const handleToggleStar = useCallback(
    (entryId: string) => {
      demoState.toggleStar(entryId);
    },
    [demoState]
  );

  return (
    <EntryList
      externalEntries={entries}
      externalQueryState={STATIC_QUERY_STATE}
      selectedEntryId={selectedEntryId}
      onEntryClick={(id) => {
        clientPush(`${backHref}?entry=${id}`);
      }}
      onToggleRead={handleToggleRead}
      onToggleStar={handleToggleStar}
      emptyMessage="No entries to display"
    />
  );
}

/**
 * DemoEntryList Component
 *
 * Thin wrapper around EntryList for the demo page.
 * Uses static data and navigates via clientPush on entry click.
 */

"use client";

import { EntryList, type ExternalQueryState } from "@/components/entries";
import { clientPush } from "@/lib/navigation";
import { type DemoEntry } from "./data";

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
}

export function DemoEntryList({ entries, backHref }: DemoEntryListProps) {
  return (
    <EntryList
      externalEntries={entries}
      externalQueryState={STATIC_QUERY_STATE}
      onEntryClick={(id) => {
        clientPush(`${backHref}?entry=${id}`);
      }}
      emptyMessage="No entries to display"
    />
  );
}

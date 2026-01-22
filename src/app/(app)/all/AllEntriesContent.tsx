/**
 * All Entries Content Component
 *
 * Client component that displays all entries.
 * Used by the page.tsx server component which handles SSR prefetching.
 */

"use client";

import { Suspense } from "react";
import { EntryPageLayout } from "@/components/entries";
import { useEntryPage } from "@/lib/hooks";

function AllEntriesContentInner() {
  const page = useEntryPage({ viewId: "all" });

  return (
    <EntryPageLayout
      page={page}
      title="All Items"
      emptyMessageUnread="No unread entries. Toggle to show all items."
      emptyMessageAll="No entries yet. Subscribe to some feeds to see entries here."
      markAllReadDescription="all feeds"
      markAllReadOptions={{}}
    />
  );
}

export function AllEntriesContent() {
  return (
    <Suspense>
      <AllEntriesContentInner />
    </Suspense>
  );
}

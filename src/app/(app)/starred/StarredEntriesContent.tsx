/**
 * Starred Entries Content Component
 *
 * Client component that displays starred entries.
 * Used by the page.tsx server component which handles SSR prefetching.
 */

"use client";

import { Suspense } from "react";
import { EntryPageLayout } from "@/components/entries";
import { useEntryPage } from "@/lib/hooks";

function StarredEntriesContentInner() {
  const page = useEntryPage({
    viewId: "starred",
    filters: { starredOnly: true },
  });

  return (
    <EntryPageLayout
      page={page}
      title="Starred"
      emptyMessageUnread="No unread starred entries. Toggle to show all starred items."
      emptyMessageAll="No starred entries yet. Star entries to save them for later."
      markAllReadDescription="starred entries"
      markAllReadOptions={{ starredOnly: true }}
    />
  );
}

export function StarredEntriesContent() {
  return (
    <Suspense>
      <StarredEntriesContentInner />
    </Suspense>
  );
}

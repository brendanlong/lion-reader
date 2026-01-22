/**
 * Uncategorized Entries Content Component
 *
 * Client component that displays entries from feeds with no tags.
 * Used by the page.tsx server component which handles SSR prefetching.
 * Also exported for reuse by TagEntriesContent when tagId is "uncategorized".
 */

"use client";

import { Suspense } from "react";
import { EntryPageLayout } from "@/components/entries";
import { useEntryPage } from "@/lib/hooks";

/**
 * Inner content component for uncategorized entries.
 * Exported for reuse by TagEntriesContent.
 */
export function UncategorizedEntriesContentInner() {
  const page = useEntryPage({
    viewId: "uncategorized",
    filters: { uncategorized: true },
  });

  return (
    <EntryPageLayout
      page={page}
      title="Uncategorized"
      emptyMessageUnread="No unread entries from uncategorized feeds. Toggle to show all items."
      emptyMessageAll="No entries from uncategorized feeds yet."
      markAllReadDescription="uncategorized feeds"
      markAllReadOptions={{ uncategorized: true }}
    />
  );
}

export function UncategorizedEntriesContent() {
  return (
    <Suspense>
      <UncategorizedEntriesContentInner />
    </Suspense>
  );
}

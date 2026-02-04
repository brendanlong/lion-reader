/**
 * Uncategorized Entries Content Component
 *
 * Client component that displays entries from feeds with no tags.
 * Used by the page.tsx server component which handles SSR prefetching.
 * Also exported for reuse by TagEntriesContent when tagId is "uncategorized".
 *
 * Uses Suspense with a smart fallback that shows cached entries while loading.
 */

"use client";

import { Suspense } from "react";
import { EntryPageLayout, EntryListFallback } from "@/components/entries";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";
import { useEntryPage } from "@/lib/hooks";
import { useUrlViewPreferences } from "@/lib/hooks/useUrlViewPreferences";

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

/**
 * Fallback component for uncategorized entries.
 * Exported for reuse by TagEntriesContent.
 */
export function UncategorizedEntriesFallback() {
  const { showUnreadOnly, sortOrder } = useUrlViewPreferences();

  return (
    <div className="mx-auto max-w-3xl px-4 py-4 sm:p-6">
      <div className="mb-4 sm:mb-6">
        <div className="h-8 w-48 animate-pulse rounded bg-zinc-200 dark:bg-zinc-700" />
      </div>
      <EntryListFallback
        filters={{ uncategorized: true, unreadOnly: showUnreadOnly, sortOrder }}
        skeletonCount={5}
      />
    </div>
  );
}

export function UncategorizedEntriesContent() {
  return (
    <ErrorBoundary message="Failed to load entries">
      <Suspense fallback={<UncategorizedEntriesFallback />}>
        <UncategorizedEntriesContentInner />
      </Suspense>
    </ErrorBoundary>
  );
}

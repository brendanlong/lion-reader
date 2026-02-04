/**
 * All Entries Content Component
 *
 * Client component that displays all entries.
 * Used by the page.tsx server component which handles SSR prefetching.
 *
 * Uses Suspense with a smart fallback that shows cached entries while loading.
 */

"use client";

import { Suspense } from "react";
import { EntryPageLayout, EntryListFallback } from "@/components/entries";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";
import { useEntryPage } from "@/lib/hooks";
import { useUrlViewPreferences } from "@/lib/hooks/useUrlViewPreferences";

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

/**
 * Fallback component that shows cached entries or skeleton.
 * Reads URL preferences to match the filters the main component will use.
 */
function AllEntriesFallback() {
  const { showUnreadOnly, sortOrder } = useUrlViewPreferences();

  return (
    <div className="mx-auto max-w-3xl px-4 py-4 sm:p-6">
      <div className="mb-4 sm:mb-6">
        <div className="h-8 w-48 animate-pulse rounded bg-zinc-200 dark:bg-zinc-700" />
      </div>
      <EntryListFallback filters={{ unreadOnly: showUnreadOnly, sortOrder }} skeletonCount={5} />
    </div>
  );
}

export function AllEntriesContent() {
  return (
    <ErrorBoundary message="Failed to load entries">
      <Suspense fallback={<AllEntriesFallback />}>
        <AllEntriesContentInner />
      </Suspense>
    </ErrorBoundary>
  );
}

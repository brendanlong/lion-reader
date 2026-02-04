/**
 * Starred Entries Content Component
 *
 * Client component that displays starred entries.
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

function StarredEntriesFallback() {
  const { showUnreadOnly, sortOrder } = useUrlViewPreferences();

  return (
    <div className="mx-auto max-w-3xl px-4 py-4 sm:p-6">
      <div className="mb-4 sm:mb-6">
        <div className="h-8 w-48 animate-pulse rounded bg-zinc-200 dark:bg-zinc-700" />
      </div>
      <EntryListFallback
        filters={{ starredOnly: true, unreadOnly: showUnreadOnly, sortOrder }}
        skeletonCount={5}
      />
    </div>
  );
}

export function StarredEntriesContent() {
  return (
    <ErrorBoundary message="Failed to load entries">
      <Suspense fallback={<StarredEntriesFallback />}>
        <StarredEntriesContentInner />
      </Suspense>
    </ErrorBoundary>
  );
}

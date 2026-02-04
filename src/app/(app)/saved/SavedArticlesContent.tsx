/**
 * Saved Articles Content Component
 *
 * Client component that displays saved articles.
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

function SavedArticlesContentInner() {
  const page = useEntryPage({
    viewId: "saved",
    filters: { type: "saved" },
  });

  return (
    <EntryPageLayout
      page={page}
      title="Saved"
      emptyMessageUnread="No unread saved articles. Toggle to show all items."
      emptyMessageAll="No saved articles yet. Save articles to read them later."
      markAllReadDescription="saved articles"
      markAllReadOptions={{ type: "saved" }}
      showUploadButton
    />
  );
}

function SavedArticlesFallback() {
  const { showUnreadOnly, sortOrder } = useUrlViewPreferences();

  return (
    <div className="mx-auto max-w-3xl px-4 py-4 sm:p-6">
      <div className="mb-4 sm:mb-6">
        <div className="h-8 w-48 animate-pulse rounded bg-zinc-200 dark:bg-zinc-700" />
      </div>
      <EntryListFallback
        filters={{ type: "saved", unreadOnly: showUnreadOnly, sortOrder }}
        skeletonCount={5}
      />
    </div>
  );
}

export function SavedArticlesContent() {
  return (
    <ErrorBoundary message="Failed to load entries">
      <Suspense fallback={<SavedArticlesFallback />}>
        <SavedArticlesContentInner />
      </Suspense>
    </ErrorBoundary>
  );
}

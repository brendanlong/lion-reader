/**
 * Saved Articles Content Component
 *
 * Client component that displays saved articles.
 * Used by the page.tsx server component which handles SSR prefetching.
 */

"use client";

import { Suspense } from "react";
import { EntryPageLayout } from "@/components/entries";
import { useEntryPage } from "@/lib/hooks";

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

export function SavedArticlesContent() {
  return (
    <Suspense>
      <SavedArticlesContentInner />
    </Suspense>
  );
}

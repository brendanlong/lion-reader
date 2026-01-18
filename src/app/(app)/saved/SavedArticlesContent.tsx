/**
 * Saved Articles Content Component
 *
 * Client component that displays saved articles.
 * Used by the page.tsx server component which handles SSR prefetching.
 */

"use client";

import { Suspense } from "react";
import { EntryList, EntryContent, UnreadToggle, SortToggle } from "@/components/entries";
import { FileUploadButton } from "@/components/saved";
import { useEntryPage } from "@/lib/hooks";

function SavedArticlesContentInner() {
  const page = useEntryPage({
    viewId: "saved",
    filters: { type: "saved" },
  });

  return (
    <>
      {page.entryContentProps && (
        <EntryContent key={page.entryContentProps.entryId} {...page.entryContentProps} />
      )}

      <div className={`mx-auto max-w-3xl px-4 py-4 sm:p-6 ${page.openEntryId ? "hidden" : ""}`}>
        <div className="mb-4 flex items-center justify-between sm:mb-6">
          <h1 className="ui-text-xl sm:ui-text-2xl font-bold text-zinc-900 dark:text-zinc-50">
            Saved
          </h1>
          <div className="flex gap-2">
            <FileUploadButton />
            <SortToggle sortOrder={page.sortOrder} onToggle={page.toggleSortOrder} />
            <UnreadToggle
              showUnreadOnly={page.showUnreadOnly}
              onToggle={page.toggleShowUnreadOnly}
            />
          </div>
        </div>

        <EntryList
          {...page.entryListProps}
          emptyMessage={
            page.showUnreadOnly
              ? "No unread saved articles. Toggle to show all items."
              : "No saved articles yet. Save articles to read them later."
          }
        />
      </div>
    </>
  );
}

export function SavedArticlesContent() {
  return (
    <Suspense>
      <SavedArticlesContentInner />
    </Suspense>
  );
}

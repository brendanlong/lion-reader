/**
 * Saved Articles Page
 *
 * Displays saved articles (read later).
 */

"use client";

import { Suspense } from "react";
import { EntryList, EntryContent, UnreadToggle, SortToggle } from "@/components/entries";
import { useEntryPage } from "@/lib/hooks";

function SavedArticlesContent() {
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
          <h1 className="text-xl font-bold text-zinc-900 sm:text-2xl dark:text-zinc-50">Saved</h1>
          <div className="flex gap-2">
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

export default function SavedArticlesPage() {
  return (
    <Suspense>
      <SavedArticlesContent />
    </Suspense>
  );
}

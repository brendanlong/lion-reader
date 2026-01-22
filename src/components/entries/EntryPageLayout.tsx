/**
 * EntryPageLayout Component
 *
 * Shared layout component for entry list pages (All, Starred, Saved, Subscription, Tag, Uncategorized).
 * Handles the common structure: EntryContent when viewing, header with title and actions, EntryList.
 */

"use client";

import { type UseEntryPageResult, type MarkAllReadOptions } from "@/lib/hooks";
import { EntryList } from "./EntryList";
import { EntryContent } from "./EntryContent";
import { UnreadToggle } from "./UnreadToggle";
import { SortToggle } from "./SortToggle";
import { MarkAllReadButton } from "./MarkAllReadButton";
import { FileUploadButton } from "@/components/saved";

/**
 * Loading skeleton for the page title.
 */
function TitleSkeleton() {
  return <div className="h-8 w-48 animate-pulse rounded bg-zinc-200 dark:bg-zinc-700" />;
}

interface EntryPageLayoutProps {
  /** The page state from useEntryPage */
  page: UseEntryPageResult;

  /** Page title - pass null to show loading skeleton */
  title: string | null;

  /** Empty message when showing unread only */
  emptyMessageUnread: string;

  /** Empty message when showing all entries */
  emptyMessageAll: string;

  /** Context description for the mark all read dialog (e.g., "all feeds", "this subscription") */
  markAllReadDescription: string;

  /** Options to pass to handleMarkAllRead */
  markAllReadOptions: MarkAllReadOptions;

  /** Whether to show the file upload button (for Saved page) */
  showUploadButton?: boolean;
}

export function EntryPageLayout({
  page,
  title,
  emptyMessageUnread,
  emptyMessageAll,
  markAllReadDescription,
  markAllReadOptions,
  showUploadButton = false,
}: EntryPageLayoutProps) {
  return (
    <>
      {page.entryContentProps && (
        <EntryContent key={page.entryContentProps.entryId} {...page.entryContentProps} />
      )}

      <div className={`mx-auto max-w-3xl px-4 py-4 sm:p-6 ${page.openEntryId ? "hidden" : ""}`}>
        <div className="mb-4 flex items-center justify-between sm:mb-6">
          {title === null ? (
            <TitleSkeleton />
          ) : (
            <h1 className="ui-text-xl sm:ui-text-2xl font-bold text-zinc-900 dark:text-zinc-50">
              {title}
            </h1>
          )}
          <div className="flex gap-2">
            {showUploadButton && <FileUploadButton />}
            <MarkAllReadButton
              contextDescription={markAllReadDescription}
              isLoading={page.isMarkAllReadPending}
              onConfirm={() => page.handleMarkAllRead(markAllReadOptions)}
            />
            <SortToggle sortOrder={page.sortOrder} onToggle={page.toggleSortOrder} />
            <UnreadToggle
              showUnreadOnly={page.showUnreadOnly}
              onToggle={page.toggleShowUnreadOnly}
            />
          </div>
        </div>

        <EntryList
          {...page.entryListProps}
          emptyMessage={page.showUnreadOnly ? emptyMessageUnread : emptyMessageAll}
        />
      </div>
    </>
  );
}

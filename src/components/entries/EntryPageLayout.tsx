/**
 * EntryPageLayout Component
 *
 * Shared layout component for entry list pages (All, Starred, Saved, Subscription, Tag, Uncategorized).
 * Handles the header with title and actions. Entry content and list are passed as slots.
 *
 * The buttons use non-suspending hooks directly, so they render immediately
 * while the entry list can suspend independently.
 */

"use client";

import { type ReactNode } from "react";
import { type MarkAllReadOptions, useEntryMutations } from "@/lib/hooks/useEntryMutations";
import { useUrlViewPreferences } from "@/lib/hooks/useUrlViewPreferences";
import { useEntryUrlState } from "@/lib/hooks/useEntryUrlState";
import { UnreadToggle } from "./UnreadToggle";
import { SortToggle } from "./SortToggle";
import { MarkAllReadButton } from "./MarkAllReadButton";
import { FileUploadButton } from "@/components/saved/FileUploadButton";

/**
 * Loading skeleton for the page title.
 */
export function TitleSkeleton() {
  return <div className="h-8 w-48 animate-pulse rounded bg-zinc-200 dark:bg-zinc-700" />;
}

/**
 * Title text component - renders the h1 with proper styling.
 */
export function TitleText({ children }: { children: ReactNode }) {
  return (
    <h1 className="ui-text-xl sm:ui-text-2xl font-bold text-zinc-900 dark:text-zinc-50">
      {children}
    </h1>
  );
}

interface EntryPageLayoutProps {
  /** Title slot - typically a Suspense-wrapped title component */
  titleSlot: ReactNode;

  /** Entry content slot - full screen view when an entry is open */
  entryContentSlot: ReactNode;

  /** Entry list slot - wrapped in Suspense by caller */
  entryListSlot: ReactNode;

  /** Context description for the mark all read dialog (e.g., "all feeds", "this subscription") */
  markAllReadDescription: string;

  /** Options to pass to handleMarkAllRead */
  markAllReadOptions: MarkAllReadOptions;

  /** Whether to show the file upload button (for Saved page) */
  showUploadButton?: boolean;

  /** Whether to hide the sort toggle (e.g., for algorithmic feed) */
  hideSortToggle?: boolean;
}

export function EntryPageLayout({
  titleSlot,
  entryContentSlot,
  entryListSlot,
  markAllReadDescription,
  markAllReadOptions,
  showUploadButton = false,
  hideSortToggle = false,
}: EntryPageLayoutProps) {
  // Use non-suspending hooks directly so buttons render immediately
  const { showUnreadOnly, toggleShowUnreadOnly, sortOrder, toggleSortOrder } =
    useUrlViewPreferences();
  const { markAllRead, isMarkAllReadPending } = useEntryMutations();
  const { openEntryId } = useEntryUrlState();

  return (
    <>
      {/* Entry content - full screen when viewing an entry */}
      {entryContentSlot}

      {/* Main content area - hidden when viewing an entry */}
      <div className={`mx-auto max-w-3xl px-4 py-4 sm:p-6 ${openEntryId ? "hidden" : ""}`}>
        {/* Header with title and buttons */}
        <div className="mb-4 flex items-center justify-between sm:mb-6">
          {titleSlot}
          <div className="flex gap-2">
            {showUploadButton && <FileUploadButton />}
            <MarkAllReadButton
              contextDescription={markAllReadDescription}
              isLoading={isMarkAllReadPending}
              onConfirm={() => markAllRead(markAllReadOptions)}
            />
            {!hideSortToggle && <SortToggle sortOrder={sortOrder} onToggle={toggleSortOrder} />}
            <UnreadToggle showUnreadOnly={showUnreadOnly} onToggle={toggleShowUnreadOnly} />
          </div>
        </div>

        {/* Entry list */}
        {entryListSlot}
      </div>
    </>
  );
}

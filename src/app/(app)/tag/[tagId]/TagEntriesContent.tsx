/**
 * Tag Entries Content Component
 *
 * Client component that displays entries from a specific tag or uncategorized feeds.
 * Used by the page.tsx server component which handles SSR prefetching.
 */

"use client";

import { Suspense, useState, useMemo } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { EntryList, EntryContent, UnreadToggle, SortToggle } from "@/components/entries";
import { MarkAllReadDialog } from "@/components/feeds/MarkAllReadDialog";
import { useEntryPage } from "@/lib/hooks";
import { trpc } from "@/lib/trpc/client";

/**
 * Loading skeleton for the tag header.
 */
function TagHeaderSkeleton() {
  return (
    <div className="mb-6 animate-pulse">
      <div className="mb-2 h-8 w-48 rounded bg-zinc-200 dark:bg-zinc-700" />
      <div className="h-4 w-32 rounded bg-zinc-200 dark:bg-zinc-700" />
    </div>
  );
}

/**
 * Error state for when the tag is not found.
 */
function TagNotFound() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-4 sm:p-6">
      <div className="rounded-lg border border-zinc-200 bg-white p-6 text-center sm:p-8 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-red-100 dark:bg-red-900/20">
          <svg
            className="h-6 w-6 text-red-500 dark:text-red-400"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
            />
          </svg>
        </div>
        <h2 className="ui-text-lg mb-2 font-medium text-zinc-900 dark:text-zinc-50">
          Tag not found
        </h2>
        <p className="ui-text-sm mb-4 text-zinc-600 dark:text-zinc-400">
          The tag you&apos;re looking for doesn&apos;t exist.
        </p>
        <Link
          href="/all"
          className="ui-text-sm inline-flex items-center font-medium text-zinc-900 hover:underline dark:text-zinc-50"
        >
          <svg className="mr-2 h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M10 19l-7-7m0 0l7-7m-7 7h18"
            />
          </svg>
          Back to All Items
        </Link>
      </div>
    </div>
  );
}

/**
 * Content for regular tag entries.
 */
function TagContent({ tagId }: { tagId: string }) {
  const [showMarkAllReadDialog, setShowMarkAllReadDialog] = useState(false);

  const page = useEntryPage({
    viewId: "tag",
    viewScopeId: tagId,
    filters: { tagId },
  });

  // Fetch tag info
  const tagsQuery = trpc.tags.list.useQuery();
  const tag = tagsQuery.data?.items.find((t) => t.id === tagId);

  // Show error if tags loaded but tag not found
  if (!tagsQuery.isLoading && !tag) {
    return <TagNotFound />;
  }

  return (
    <>
      {page.entryContentProps && (
        <EntryContent key={page.entryContentProps.entryId} {...page.entryContentProps} />
      )}

      <div className={`mx-auto max-w-3xl px-4 py-4 sm:p-6 ${page.openEntryId ? "hidden" : ""}`}>
        <div className="mb-4 sm:mb-6">
          {/* Breadcrumb back link */}
          <Link
            href="/all"
            className="ui-text-sm mb-2 -ml-2 inline-flex min-h-[36px] items-center rounded-md px-2 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-700 active:bg-zinc-200 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200 dark:active:bg-zinc-700"
          >
            <svg className="mr-1 h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M10 19l-7-7m0 0l7-7m-7 7h18"
              />
            </svg>
            All Items
          </Link>

          {/* Tag header with color dot - show skeleton only if we have no data at all
              (if data is cached from sidebar, show it immediately even during refetch) */}
          {!tag ? (
            <TagHeaderSkeleton />
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <span
                  className="inline-block h-4 w-4 rounded-full"
                  style={{ backgroundColor: tag?.color || "#6b7280" }}
                  aria-hidden="true"
                />
                <h1 className="ui-text-xl sm:ui-text-2xl font-bold text-zinc-900 dark:text-zinc-50">
                  {tag?.name}
                </h1>
                {tag && tag.feedCount > 0 && (
                  <span className="ui-text-sm rounded-full bg-zinc-100 px-2.5 py-0.5 text-zinc-600 sm:px-3 sm:py-1 dark:bg-zinc-800 dark:text-zinc-400">
                    {tag.feedCount} feed{tag.feedCount !== 1 ? "s" : ""}
                  </span>
                )}
              </div>
              <div className="flex gap-2">
                {tag && tag.unreadCount > 0 && (
                  <button
                    type="button"
                    onClick={() => setShowMarkAllReadDialog(true)}
                    className="inline-flex items-center justify-center rounded-md p-2 text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-700 focus:ring-2 focus:ring-zinc-500 focus:ring-offset-2 focus:outline-none dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200 dark:focus:ring-zinc-400"
                    title="Mark all as read"
                    aria-label="Mark all as read"
                  >
                    <svg
                      className="h-5 w-5"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={1.5}
                      aria-hidden="true"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                      />
                    </svg>
                    <span className="ui-text-sm ml-1.5 hidden sm:inline">Mark All Read</span>
                  </button>
                )}
                <SortToggle sortOrder={page.sortOrder} onToggle={page.toggleSortOrder} />
                <UnreadToggle
                  showUnreadOnly={page.showUnreadOnly}
                  onToggle={page.toggleShowUnreadOnly}
                />
              </div>
            </div>
          )}
        </div>

        {/* Always render entry list - it can show placeholder data while loading */}
        <EntryList
          {...page.entryListProps}
          emptyMessage={
            page.showUnreadOnly
              ? `No unread entries from feeds tagged with "${tag?.name ?? "this tag"}". Toggle to show all items.`
              : `No entries from feeds tagged with "${tag?.name ?? "this tag"}" yet.`
          }
        />

        <MarkAllReadDialog
          isOpen={showMarkAllReadDialog}
          contextDescription={`the "${tag?.name}" tag`}
          unreadCount={tag?.unreadCount ?? 0}
          isLoading={page.isMarkAllReadPending}
          onConfirm={() => {
            page.handleMarkAllRead({ tagId });
            setShowMarkAllReadDialog(false);
          }}
          onCancel={() => setShowMarkAllReadDialog(false)}
        />
      </div>
    </>
  );
}

/**
 * Content for uncategorized entries (feeds with no tags).
 */
function UncategorizedContent() {
  const [showMarkAllReadDialog, setShowMarkAllReadDialog] = useState(false);

  const page = useEntryPage({
    viewId: "uncategorized",
    filters: { uncategorized: true },
  });

  // Compute uncategorized feed stats
  const uncategorizedFeeds = useMemo(() => {
    return page.subscriptions?.items.filter((item) => item.tags.length === 0) ?? [];
  }, [page.subscriptions?.items]);

  const feedCount = uncategorizedFeeds.length;
  const unreadCount = useMemo(() => {
    return uncategorizedFeeds.reduce((sum, item) => sum + item.unreadCount, 0);
  }, [uncategorizedFeeds]);

  return (
    <>
      {page.entryContentProps && (
        <EntryContent key={page.entryContentProps.entryId} {...page.entryContentProps} />
      )}

      <div className={`mx-auto max-w-3xl px-4 py-4 sm:p-6 ${page.openEntryId ? "hidden" : ""}`}>
        <div className="mb-4 sm:mb-6">
          {/* Breadcrumb back link */}
          <Link
            href="/all"
            className="ui-text-sm mb-2 -ml-2 inline-flex min-h-[36px] items-center rounded-md px-2 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-700 active:bg-zinc-200 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200 dark:active:bg-zinc-700"
          >
            <svg className="mr-1 h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M10 19l-7-7m0 0l7-7m-7 7h18"
              />
            </svg>
            All Items
          </Link>

          {/* Uncategorized header with gray color dot - show skeleton only if we have no data
              (if data is cached from sidebar, show it immediately even during refetch) */}
          {!page.subscriptions ? (
            <TagHeaderSkeleton />
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <span
                  className="inline-block h-4 w-4 rounded-full"
                  style={{ backgroundColor: "#6b7280" }}
                  aria-hidden="true"
                />
                <h1 className="ui-text-xl sm:ui-text-2xl font-bold text-zinc-900 dark:text-zinc-50">
                  Uncategorized
                </h1>
                {feedCount > 0 && (
                  <span className="ui-text-sm rounded-full bg-zinc-100 px-2.5 py-0.5 text-zinc-600 sm:px-3 sm:py-1 dark:bg-zinc-800 dark:text-zinc-400">
                    {feedCount} feed{feedCount !== 1 ? "s" : ""}
                  </span>
                )}
              </div>
              <div className="flex gap-2">
                {unreadCount > 0 && (
                  <button
                    type="button"
                    onClick={() => setShowMarkAllReadDialog(true)}
                    className="inline-flex items-center justify-center rounded-md p-2 text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-700 focus:ring-2 focus:ring-zinc-500 focus:ring-offset-2 focus:outline-none dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200 dark:focus:ring-zinc-400"
                    title="Mark all as read"
                    aria-label="Mark all as read"
                  >
                    <svg
                      className="h-5 w-5"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={1.5}
                      aria-hidden="true"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                      />
                    </svg>
                    <span className="ui-text-sm ml-1.5 hidden sm:inline">Mark All Read</span>
                  </button>
                )}
                <SortToggle sortOrder={page.sortOrder} onToggle={page.toggleSortOrder} />
                <UnreadToggle
                  showUnreadOnly={page.showUnreadOnly}
                  onToggle={page.toggleShowUnreadOnly}
                />
              </div>
            </div>
          )}
        </div>

        {/* Always render entry list - it can show placeholder data while loading */}
        <EntryList
          {...page.entryListProps}
          emptyMessage={
            page.showUnreadOnly
              ? "No unread entries from uncategorized feeds. Toggle to show all items."
              : "No entries from uncategorized feeds yet."
          }
        />

        <MarkAllReadDialog
          isOpen={showMarkAllReadDialog}
          contextDescription="uncategorized feeds"
          unreadCount={unreadCount}
          isLoading={page.isMarkAllReadPending}
          onConfirm={() => {
            page.handleMarkAllRead({ uncategorized: true });
            setShowMarkAllReadDialog(false);
          }}
          onCancel={() => setShowMarkAllReadDialog(false)}
        />
      </div>
    </>
  );
}

function TagEntriesContentInner() {
  const params = useParams<{ tagId: string }>();
  const tagId = params.tagId;
  const isUncategorized = tagId === "uncategorized";

  if (isUncategorized) {
    return <UncategorizedContent />;
  }

  return <TagContent tagId={tagId} />;
}

export function TagEntriesContent() {
  return (
    <Suspense>
      <TagEntriesContentInner />
    </Suspense>
  );
}

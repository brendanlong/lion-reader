/**
 * Single Subscription Client Component
 *
 * Client-side component for the Single Subscription page.
 * Contains all the interactive logic for displaying and managing entries from a specific subscription.
 */

"use client";

import { Suspense, useState, useCallback, useMemo } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { trpc } from "@/lib/trpc/client";
import {
  EntryList,
  EntryContent,
  UnreadToggle,
  SortToggle,
  type ExternalQueryState,
} from "@/components/entries";
import { MarkAllReadDialog } from "@/components/feeds/MarkAllReadDialog";
import { useKeyboardShortcutsContext } from "@/components/keyboard";
import {
  useKeyboardShortcuts,
  useUrlViewPreferences,
  useEntryMutations,
  useEntryUrlState,
  useEntryListQuery,
} from "@/lib/hooks";

/**
 * Loading skeleton for the subscription header.
 */
function SubscriptionHeaderSkeleton() {
  return (
    <div className="mb-6 animate-pulse">
      <div className="mb-2 h-8 w-48 rounded bg-zinc-200 dark:bg-zinc-700" />
      <div className="h-4 w-32 rounded bg-zinc-200 dark:bg-zinc-700" />
    </div>
  );
}

/**
 * Error state for when the subscription is not found.
 */
function SubscriptionNotFound() {
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
        <h2 className="mb-2 text-lg font-medium text-zinc-900 dark:text-zinc-50">
          Subscription not found
        </h2>
        <p className="mb-4 text-sm text-zinc-600 dark:text-zinc-400">
          The subscription you&apos;re looking for doesn&apos;t exist or you&apos;re not subscribed
          to it.
        </p>
        <Link
          href="/all"
          className="inline-flex items-center text-sm font-medium text-zinc-900 hover:underline dark:text-zinc-50"
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

function SingleSubscriptionContent() {
  const params = useParams<{ id: string }>();
  const subscriptionId = params.id;

  const { openEntryId, setOpenEntryId, closeEntry } = useEntryUrlState();
  const [showMarkAllReadDialog, setShowMarkAllReadDialog] = useState(false);

  const { enabled: keyboardShortcutsEnabled } = useKeyboardShortcutsContext();
  const { showUnreadOnly, toggleShowUnreadOnly, sortOrder, toggleSortOrder } =
    useUrlViewPreferences("subscription", subscriptionId);
  const utils = trpc.useUtils();

  // Use entry list query that stays mounted while viewing entries
  const entryListQuery = useEntryListQuery({
    filters: { subscriptionId, unreadOnly: showUnreadOnly, sortOrder },
    openEntryId,
  });

  // Entry mutations with optimistic updates
  const { toggleRead, toggleStar, markAllRead, isMarkAllReadPending } = useEntryMutations({
    listFilters: { subscriptionId, unreadOnly: showUnreadOnly, sortOrder },
  });

  const handleMarkAllRead = useCallback(() => {
    markAllRead({ subscriptionId });
    setShowMarkAllReadDialog(false);
  }, [markAllRead, subscriptionId]);

  // Keyboard navigation and actions (also provides swipe navigation functions)
  const { selectedEntryId, setSelectedEntryId, goToNextEntry, goToPreviousEntry } =
    useKeyboardShortcuts({
      entries: entryListQuery.entries,
      onOpenEntry: setOpenEntryId,
      onClose: closeEntry,
      isEntryOpen: !!openEntryId,
      enabled: keyboardShortcutsEnabled,
      onToggleRead: toggleRead,
      onToggleStar: toggleStar,
      onRefresh: () => {
        utils.entries.list.invalidate();
      },
      onToggleUnreadOnly: toggleShowUnreadOnly,
    });

  // Fetch subscription info to get title and validate access
  const subscriptionsQuery = trpc.subscriptions.list.useQuery();

  // Find the subscription by ID
  const subscription = subscriptionsQuery.data?.items.find((item) => item.id === subscriptionId);

  const handleEntryClick = useCallback(
    (entryId: string) => {
      setSelectedEntryId(entryId);
      setOpenEntryId(entryId);
    },
    [setSelectedEntryId, setOpenEntryId]
  );

  const handleBack = useCallback(() => {
    closeEntry();
  }, [closeEntry]);

  // Build external query state for EntryList
  const externalQueryState: ExternalQueryState = useMemo(
    () => ({
      isLoading: entryListQuery.isLoading,
      isError: entryListQuery.isError,
      errorMessage: entryListQuery.errorMessage,
      isFetchingNextPage: entryListQuery.isFetchingNextPage,
      hasNextPage: entryListQuery.hasNextPage,
      fetchNextPage: entryListQuery.fetchNextPage,
      refetch: entryListQuery.refetch,
      prefetchEntry: entryListQuery.prefetchEntry,
    }),
    [entryListQuery]
  );

  // Show loading state while checking subscription
  if (subscriptionsQuery.isLoading) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-4 sm:p-6">
        <SubscriptionHeaderSkeleton />
      </div>
    );
  }

  // Show error if subscription not found (not subscribed)
  if (!subscription) {
    return <SubscriptionNotFound />;
  }

  const feedTitle = subscription.title ?? subscription.originalTitle ?? "Untitled Feed";
  const unreadCount = subscription.unreadCount;

  // Render both list and content, hiding the list when viewing an entry.
  // This preserves scroll position and enables seamless j/k navigation.
  return (
    <>
      {/* Entry content - only rendered when an entry is open */}
      {openEntryId && (
        <EntryContent
          key={openEntryId}
          entryId={openEntryId}
          listFilters={{ subscriptionId, unreadOnly: showUnreadOnly, sortOrder }}
          onBack={handleBack}
          onSwipeNext={goToNextEntry}
          onSwipePrevious={goToPreviousEntry}
          nextEntryId={entryListQuery.nextEntryId}
          previousEntryId={entryListQuery.previousEntryId}
        />
      )}

      {/* Entry list - always mounted but hidden when viewing an entry */}
      <div className={`mx-auto max-w-3xl px-4 py-4 sm:p-6 ${openEntryId ? "hidden" : ""}`}>
        <div className="mb-4 sm:mb-6">
          {/* Breadcrumb back link */}
          <Link
            href="/all"
            className="mb-2 -ml-2 inline-flex min-h-[36px] items-center rounded-md px-2 text-sm text-zinc-500 hover:bg-zinc-100 hover:text-zinc-700 active:bg-zinc-200 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200 dark:active:bg-zinc-700"
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

          {/* Feed title and unread count */}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h1 className="text-xl font-bold text-zinc-900 sm:text-2xl dark:text-zinc-50">
              {feedTitle}
            </h1>
            <div className="flex items-center gap-2">
              {unreadCount > 0 && (
                <>
                  <span className="rounded-full bg-zinc-100 px-2.5 py-0.5 text-sm text-zinc-600 sm:px-3 sm:py-1 dark:bg-zinc-800 dark:text-zinc-400">
                    {unreadCount} unread
                  </span>
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
                    <span className="ml-1.5 hidden text-sm sm:inline">Mark All Read</span>
                  </button>
                </>
              )}
              <SortToggle sortOrder={sortOrder} onToggle={toggleSortOrder} />
              <UnreadToggle showUnreadOnly={showUnreadOnly} onToggle={toggleShowUnreadOnly} />
            </div>
          </div>

          {/* Feed URL if available */}
          {subscription.siteUrl && (
            <a
              href={subscription.siteUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-1 inline-block text-sm text-zinc-500 hover:underline dark:text-zinc-400"
            >
              {new URL(subscription.siteUrl).hostname}
            </a>
          )}
        </div>

        <EntryList
          filters={{ subscriptionId, unreadOnly: showUnreadOnly, sortOrder }}
          onEntryClick={handleEntryClick}
          selectedEntryId={selectedEntryId}
          onToggleRead={toggleRead}
          onToggleStar={toggleStar}
          externalEntries={entryListQuery.entries}
          externalQueryState={externalQueryState}
          emptyMessage={
            showUnreadOnly
              ? "No unread entries in this subscription. Toggle to show all items."
              : "No entries in this subscription yet. Entries will appear here once the feed is fetched."
          }
        />

        <MarkAllReadDialog
          isOpen={showMarkAllReadDialog}
          contextDescription="this subscription"
          unreadCount={unreadCount}
          isLoading={isMarkAllReadPending}
          onConfirm={handleMarkAllRead}
          onCancel={() => setShowMarkAllReadDialog(false)}
        />
      </div>
    </>
  );
}

export function SingleSubscriptionClient() {
  return (
    <Suspense>
      <SingleSubscriptionContent />
    </Suspense>
  );
}

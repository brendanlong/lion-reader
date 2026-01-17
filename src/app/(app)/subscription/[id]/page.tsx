/**
 * Single Subscription Page
 *
 * Displays entries from a specific subscription.
 */

"use client";

import { Suspense, useState, useMemo } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { EntryList, EntryContent, UnreadToggle, SortToggle } from "@/components/entries";
import { MarkAllReadDialog } from "@/components/feeds/MarkAllReadDialog";
import { useEntryPage } from "@/lib/hooks";

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
        <p className="ui-text-sm mb-4 text-zinc-600 dark:text-zinc-400">
          The subscription you&apos;re looking for doesn&apos;t exist or you&apos;re not subscribed
          to it.
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

function SingleSubscriptionContent() {
  const params = useParams<{ id: string }>();
  const subscriptionId = params.id;
  const [showMarkAllReadDialog, setShowMarkAllReadDialog] = useState(false);

  const page = useEntryPage({
    viewId: "subscription",
    viewScopeId: subscriptionId,
    filters: { subscriptionId },
  });

  // Find the subscription
  const subscription = useMemo(
    () => page.subscriptions?.items.find((item) => item.id === subscriptionId),
    [page.subscriptions, subscriptionId]
  );

  // Show loading state while checking subscription
  if (page.subscriptionsLoading) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-4 sm:p-6">
        <SubscriptionHeaderSkeleton />
      </div>
    );
  }

  // Show error if subscription not found
  if (!subscription) {
    return <SubscriptionNotFound />;
  }

  const feedTitle =
    (subscription as { title?: string }).title ??
    (subscription as { originalTitle?: string }).originalTitle ??
    "Untitled Feed";
  const unreadCount = subscription.unreadCount;
  const siteUrl = (subscription as { siteUrl?: string }).siteUrl;

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

          {/* Feed title and unread count */}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h1 className="text-xl font-bold text-zinc-900 sm:text-2xl dark:text-zinc-50">
              {feedTitle}
            </h1>
            <div className="flex items-center gap-2">
              {unreadCount > 0 && (
                <>
                  <span className="ui-text-sm rounded-full bg-zinc-100 px-2.5 py-0.5 text-zinc-600 sm:px-3 sm:py-1 dark:bg-zinc-800 dark:text-zinc-400">
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
              <SortToggle sortOrder={page.sortOrder} onToggle={page.toggleSortOrder} />
              <UnreadToggle
                showUnreadOnly={page.showUnreadOnly}
                onToggle={page.toggleShowUnreadOnly}
              />
            </div>
          </div>

          {/* Feed URL if available */}
          {siteUrl && (
            <a
              href={siteUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="ui-text-sm mt-1 inline-block text-zinc-500 hover:underline dark:text-zinc-400"
            >
              {new URL(siteUrl).hostname}
            </a>
          )}
        </div>

        <EntryList
          {...page.entryListProps}
          emptyMessage={
            page.showUnreadOnly
              ? "No unread entries in this subscription. Toggle to show all items."
              : "No entries in this subscription yet. Entries will appear here once the feed is fetched."
          }
        />

        <MarkAllReadDialog
          isOpen={showMarkAllReadDialog}
          contextDescription="this subscription"
          unreadCount={unreadCount}
          isLoading={page.isMarkAllReadPending}
          onConfirm={() => {
            page.handleMarkAllRead({ subscriptionId });
            setShowMarkAllReadDialog(false);
          }}
          onCancel={() => setShowMarkAllReadDialog(false)}
        />
      </div>
    </>
  );
}

export default function SingleSubscriptionPage() {
  return (
    <Suspense>
      <SingleSubscriptionContent />
    </Suspense>
  );
}

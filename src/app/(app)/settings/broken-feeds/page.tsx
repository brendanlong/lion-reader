/**
 * Broken Feeds Settings Page
 *
 * Displays feeds with fetch errors and allows users to retry fetching.
 * Shows error messages, failure counts, and last fetch times.
 */

"use client";

import { useState } from "react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc/client";
import { Button, Alert } from "@/components/ui";

// ============================================================================
// Types
// ============================================================================

interface BrokenFeed {
  feedId: string;
  subscriptionId: string;
  title: string | null;
  url: string | null;
  consecutiveFailures: number;
  lastError: string | null;
  lastFetchedAt: Date | null;
  nextFetchAt: Date | null;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Format a date relative to now (e.g., "2 hours ago", "Jan 15, 2024")
 */
function formatRelativeDate(date: Date | null): string {
  if (!date) return "Never";

  const now = new Date();
  const dateObj = new Date(date);
  const diffMs = now.getTime() - dateObj.getTime();
  const diffMins = Math.floor(diffMs / (1000 * 60));
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffMins < 1) {
    return "Just now";
  } else if (diffMins < 60) {
    return `${diffMins} minute${diffMins === 1 ? "" : "s"} ago`;
  } else if (diffHours < 24) {
    return `${diffHours} hour${diffHours === 1 ? "" : "s"} ago`;
  } else if (diffDays === 1) {
    return "Yesterday";
  } else if (diffDays < 7) {
    return `${diffDays} days ago`;
  } else {
    return dateObj.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  }
}

/**
 * Format a future date (for next fetch time)
 */
function formatFutureDate(date: Date | null): string {
  if (!date) return "Not scheduled";

  const now = new Date();
  const dateObj = new Date(date);
  const diffMs = dateObj.getTime() - now.getTime();

  // If in the past, it's scheduled to run soon
  if (diffMs <= 0) {
    return "Pending";
  }

  const diffMins = Math.floor(diffMs / (1000 * 60));
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffMins < 60) {
    return `In ${diffMins} minute${diffMins === 1 ? "" : "s"}`;
  } else if (diffHours < 24) {
    return `In ${diffHours} hour${diffHours === 1 ? "" : "s"}`;
  } else {
    return `In ${diffDays} day${diffDays === 1 ? "" : "s"}`;
  }
}

/**
 * Get display name for a feed
 */
function getFeedDisplayName(feed: BrokenFeed): string {
  if (feed.title) return feed.title;
  if (feed.url) {
    try {
      const url = new URL(feed.url);
      return url.hostname;
    } catch {
      return feed.url;
    }
  }
  return "Unknown Feed";
}

// ============================================================================
// Main Component
// ============================================================================

export default function BrokenFeedsPage() {
  const brokenQuery = trpc.brokenFeeds.list.useQuery();

  const feeds = brokenQuery.data?.items ?? [];

  return (
    <div>
      {/* Page Header */}
      <div className="mb-6">
        <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">Broken Feeds</h2>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          These feeds have failed to fetch recently. You can retry fetching immediately or wait for
          the next scheduled attempt.
        </p>
      </div>

      {/* Broken Feeds List */}
      <div className="rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
        {brokenQuery.isLoading ? (
          <div className="p-6">
            {[1, 2, 3].map((i) => (
              <div
                key={i}
                className="mb-4 h-24 animate-pulse rounded bg-zinc-100 last:mb-0 dark:bg-zinc-800"
              />
            ))}
          </div>
        ) : brokenQuery.error ? (
          <div className="p-6">
            <Alert variant="error">Failed to load broken feeds. Please try again.</Alert>
          </div>
        ) : feeds.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="divide-y divide-zinc-200 dark:divide-zinc-800">
            {feeds.map((feed) => (
              <BrokenFeedRow key={feed.feedId} feed={feed} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================================
// Empty State
// ============================================================================

function EmptyState() {
  return (
    <div className="p-8 text-center">
      <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-green-100 dark:bg-green-900/30">
        <svg
          className="h-6 w-6 text-green-600 dark:text-green-400"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
        </svg>
      </div>
      <h3 className="mt-4 text-sm font-medium text-zinc-900 dark:text-zinc-50">
        All feeds are working
      </h3>
      <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
        None of your subscribed feeds have fetch errors.
      </p>
    </div>
  );
}

// ============================================================================
// Broken Feed Row
// ============================================================================

interface BrokenFeedRowProps {
  feed: BrokenFeed;
}

function BrokenFeedRow({ feed }: BrokenFeedRowProps) {
  const [isRetrying, setIsRetrying] = useState(false);

  const utils = trpc.useUtils();

  const retryMutation = trpc.brokenFeeds.retryFetch.useMutation({
    onMutate: () => {
      setIsRetrying(true);
    },
    onSuccess: () => {
      utils.brokenFeeds.list.invalidate();
      toast.success("Feed fetch scheduled");
    },
    onError: (error) => {
      toast.error(error.message || "Failed to retry fetch");
    },
    onSettled: () => {
      setIsRetrying(false);
    },
  });

  const handleRetry = () => {
    retryMutation.mutate({ feedId: feed.feedId });
  };

  const displayName = getFeedDisplayName(feed);

  return (
    <div className="p-4">
      {/* Main Row Content */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          {/* Feed Title */}
          <p className="font-medium text-zinc-900 dark:text-zinc-50">{displayName}</p>

          {/* Feed URL */}
          {feed.url && feed.title && (
            <p className="mt-0.5 truncate text-sm text-zinc-500 dark:text-zinc-400">{feed.url}</p>
          )}

          {/* Error Message */}
          {feed.lastError && (
            <div className="mt-2 rounded-md bg-red-50 px-3 py-2 dark:bg-red-900/20">
              <p className="text-sm text-red-700 dark:text-red-300">
                <span className="font-medium">Error:</span> {feed.lastError}
              </p>
            </div>
          )}

          {/* Metadata */}
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm text-zinc-500 dark:text-zinc-400">
            <span className="flex items-center gap-1">
              <svg
                className="h-4 w-4 text-red-500"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                />
              </svg>
              {feed.consecutiveFailures} consecutive failure
              {feed.consecutiveFailures === 1 ? "" : "s"}
            </span>
            <span>Last attempt: {formatRelativeDate(feed.lastFetchedAt)}</span>
            <span>Next retry: {formatFutureDate(feed.nextFetchAt)}</span>
          </div>
        </div>

        {/* Retry Button */}
        <Button variant="secondary" size="sm" onClick={handleRetry} loading={isRetrying}>
          Retry Now
        </Button>
      </div>
    </div>
  );
}

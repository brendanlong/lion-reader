/**
 * Broken Feeds Settings Page
 *
 * Displays feeds with fetch errors and allows users to retry fetching.
 * Shows error messages, failure counts, and last fetch times.
 */

"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc/client";
import { useCollections } from "@/lib/collections/context";
import { handleSubscriptionDeleted } from "@/lib/cache/operations";
import { getFeedDisplayName, formatRelativeTime, formatFutureTime } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { SettingsListContainer } from "@/components/settings/SettingsListContainer";
import { CheckIcon, AlertCircleIcon } from "@/components/ui/icon-button";
import { UnsubscribeDialog } from "@/components/feeds/UnsubscribeDialog";

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
// Main Component
// ============================================================================

export default function BrokenFeedsSettingsContent() {
  const queryClient = useQueryClient();
  const collections = useCollections();
  const [unsubscribeTarget, setUnsubscribeTarget] = useState<{
    id: string;
    title: string;
  } | null>(null);

  const utils = trpc.useUtils();
  const brokenQuery = trpc.brokenFeeds.list.useQuery();

  const unsubscribeMutation = trpc.subscriptions.delete.useMutation({
    onMutate: (variables) => {
      // Use centralized cache operation for optimistic removal
      handleSubscriptionDeleted(utils, variables.id, queryClient, collections);
    },
    onSuccess: () => {
      utils.brokenFeeds.list.invalidate();
      setUnsubscribeTarget(null);
      toast.success("Unsubscribed from feed");
    },
    onError: () => {
      toast.error("Failed to unsubscribe from feed");
      // On error, invalidate to refetch correct state
      utils.subscriptions.list.invalidate();
      utils.tags.list.invalidate();
      utils.entries.count.invalidate();
    },
  });

  const handleUnsubscribe = (subscriptionId: string, title: string) => {
    setUnsubscribeTarget({ id: subscriptionId, title });
  };

  const feeds = brokenQuery.data?.items ?? [];

  return (
    <div>
      {/* Page Header */}
      <div className="mb-6">
        <h2 className="ui-text-lg font-semibold text-zinc-900 dark:text-zinc-50">Broken Feeds</h2>
        <p className="ui-text-sm mt-1 text-zinc-600 dark:text-zinc-400">
          These feeds have failed to fetch recently. You can retry fetching immediately or wait for
          the next scheduled attempt.
        </p>
      </div>

      {/* Broken Feeds List */}
      <SettingsListContainer
        items={feeds}
        isLoading={brokenQuery.isLoading}
        error={brokenQuery.error}
        errorMessage="Failed to load broken feeds. Please try again."
        emptyState={<EmptyState />}
        renderItem={(feed) => (
          <BrokenFeedRow key={feed.feedId} feed={feed} onUnsubscribe={handleUnsubscribe} />
        )}
      />

      {/* Unsubscribe Confirmation Dialog */}
      <UnsubscribeDialog
        isOpen={unsubscribeTarget !== null}
        feedTitle={unsubscribeTarget?.title ?? ""}
        isLoading={unsubscribeMutation.isPending}
        onConfirm={() => {
          if (unsubscribeTarget) {
            unsubscribeMutation.mutate({ id: unsubscribeTarget.id });
          }
        }}
        onCancel={() => setUnsubscribeTarget(null)}
      />
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
        <CheckIcon className="h-6 w-6 text-green-600 dark:text-green-400" />
      </div>
      <h3 className="ui-text-sm mt-4 font-medium text-zinc-900 dark:text-zinc-50">
        All feeds are working
      </h3>
      <p className="ui-text-sm mt-1 text-zinc-500 dark:text-zinc-400">
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
  onUnsubscribe: (subscriptionId: string, title: string) => void;
}

function BrokenFeedRow({ feed, onUnsubscribe }: BrokenFeedRowProps) {
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
            <p className="ui-text-sm mt-0.5 truncate text-zinc-500 dark:text-zinc-400">
              {feed.url}
            </p>
          )}

          {/* Error Message */}
          {feed.lastError && (
            <div className="mt-2 rounded-md bg-red-50 px-3 py-2 dark:bg-red-900/20">
              <p className="ui-text-sm text-red-700 dark:text-red-300">
                <span className="font-medium">Error:</span> {feed.lastError}
              </p>
            </div>
          )}

          {/* Metadata */}
          <div className="ui-text-sm mt-2 flex flex-wrap gap-x-4 gap-y-1 text-zinc-500 dark:text-zinc-400">
            <span className="flex items-center gap-1">
              <AlertCircleIcon className="h-4 w-4 text-red-500" />
              {feed.consecutiveFailures} consecutive failure
              {feed.consecutiveFailures === 1 ? "" : "s"}
            </span>
            <span>
              Last attempt:{" "}
              {feed.lastFetchedAt ? formatRelativeTime(new Date(feed.lastFetchedAt)) : "Never"}
            </span>
            <span>Next retry: {formatFutureTime(feed.nextFetchAt)}</span>
          </div>
        </div>

        {/* Action Buttons */}
        <div className="flex shrink-0 gap-2">
          <Button variant="secondary" size="sm" onClick={handleRetry} loading={isRetrying}>
            Retry Now
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => onUnsubscribe(feed.subscriptionId, displayName)}
            className="text-red-600 hover:bg-red-50 hover:text-red-700 dark:text-red-400 dark:hover:bg-red-900/20 dark:hover:text-red-300"
          >
            Unsubscribe
          </Button>
        </div>
      </div>
    </div>
  );
}

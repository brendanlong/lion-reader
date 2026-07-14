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
import { useUnsubscribeMutation } from "@/lib/hooks/useUnsubscribeMutation";
import { getFeedDisplayName, formatRelativeTime, formatFutureTime } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { SettingsListContainer } from "@/components/settings/SettingsListContainer";
import { CheckIcon, AlertCircleIcon } from "@/components/ui/icon-button";
import { UnsubscribeDialog } from "@/components/feeds/UnsubscribeDialog";
import { FileFeedIssueDialog } from "@/components/feeds/FileFeedIssueDialog";

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

interface IssueTarget {
  displayName: string;
  title: string | null;
  url: string | null;
  lastError: string | null;
  consecutiveFailures: number;
}

export default function BrokenFeedsSettingsContent() {
  const [unsubscribeTarget, setUnsubscribeTarget] = useState<{
    id: string;
    title: string;
  } | null>(null);
  const [issueTarget, setIssueTarget] = useState<IssueTarget | null>(null);

  const utils = trpc.useUtils();
  const brokenQuery = trpc.brokenFeeds.list.useQuery();

  // The shared hook owns the cache choreography; this page additionally refreshes
  // the broken-feeds list, closes the dialog, and toasts on success.
  const unsubscribeMutation = useUnsubscribeMutation({
    onSuccess: () => {
      utils.brokenFeeds.list.invalidate();
      setUnsubscribeTarget(null);
      toast.success("Unsubscribed from feed");
    },
  });

  const handleUnsubscribe = (subscriptionId: string, title: string) => {
    setUnsubscribeTarget({ id: subscriptionId, title });
  };

  const handleFileIssue = (target: IssueTarget) => {
    setIssueTarget(target);
  };

  const feeds = brokenQuery.data?.items ?? [];

  return (
    <div>
      {/* Page Header */}
      <div className="mb-6">
        <h2 className="ui-text-lg text-strong font-semibold">Broken Feeds</h2>
        <p className="ui-text-sm text-muted mt-1">
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
          <BrokenFeedRow
            key={feed.feedId}
            feed={feed}
            onUnsubscribe={handleUnsubscribe}
            onFileIssue={handleFileIssue}
          />
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

      {/* File Issue Dialog */}
      <FileFeedIssueDialog
        isOpen={issueTarget !== null}
        feed={issueTarget}
        onClose={() => setIssueTarget(null)}
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
      <div className="bg-success-subtle mx-auto flex h-12 w-12 items-center justify-center rounded-full">
        <CheckIcon className="text-success h-6 w-6" />
      </div>
      <h3 className="ui-text-sm text-strong mt-4 font-medium">All feeds are working</h3>
      <p className="ui-text-sm text-muted mt-1">None of your subscribed feeds have fetch errors.</p>
    </div>
  );
}

// ============================================================================
// Broken Feed Row
// ============================================================================

interface BrokenFeedRowProps {
  feed: BrokenFeed;
  onUnsubscribe: (subscriptionId: string, title: string) => void;
  onFileIssue: (target: IssueTarget) => void;
}

function BrokenFeedRow({ feed, onUnsubscribe, onFileIssue }: BrokenFeedRowProps) {
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
          <p className="text-strong font-medium">{displayName}</p>

          {/* Feed URL */}
          {feed.url && feed.title && (
            <p className="ui-text-sm text-muted mt-0.5 truncate">{feed.url}</p>
          )}

          {/* Error Message */}
          {feed.lastError && (
            <div className="bg-danger-subtle mt-2 rounded-md px-3 py-2">
              <p className="ui-text-sm text-danger">
                <span className="font-medium">Error:</span> {feed.lastError}
              </p>
            </div>
          )}

          {/* Metadata */}
          <div className="ui-text-sm text-muted mt-2 flex flex-wrap gap-x-4 gap-y-1">
            <span className="flex items-center gap-1">
              <AlertCircleIcon className="text-danger h-4 w-4" />
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
        <div className="flex shrink-0 flex-wrap gap-2">
          <Button variant="secondary" size="sm" onClick={handleRetry} loading={isRetrying}>
            Retry Now
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() =>
              onFileIssue({
                displayName,
                title: feed.title,
                url: feed.url,
                lastError: feed.lastError,
                consecutiveFailures: feed.consecutiveFailures,
              })
            }
          >
            Report Issue
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => onUnsubscribe(feed.subscriptionId, displayName)}
            className="text-danger hover:bg-danger-subtle hover:text-danger-hover"
          >
            Unsubscribe
          </Button>
        </div>
      </div>
    </div>
  );
}

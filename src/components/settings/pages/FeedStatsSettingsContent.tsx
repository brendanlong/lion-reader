/**
 * Feed Stats Settings Page
 *
 * Displays fetch statistics for all subscribed feeds including
 * last fetch time, next scheduled fetch, error states, and WebSub status.
 * Uses infinite scroll for cursor-based pagination.
 */

"use client";

import { useCallback, useEffect, useRef, useMemo } from "react";
import { trpc } from "@/lib/trpc/client";
import {
  getFeedDisplayName,
  formatRelativeTime,
  formatFutureTime,
  formatBytes,
} from "@/lib/format";
import { Alert } from "@/components/ui/alert";
import { SettingsListSkeleton } from "@/components/settings/SettingsListSkeleton";
import {
  RssIcon,
  ClockIcon,
  CalendarIcon,
  RefreshIcon,
  DocumentIcon,
  SpinnerIcon,
} from "@/components/ui/icon-button";

// ============================================================================
// Constants
// ============================================================================

const PAGE_SIZE = 50;

// ============================================================================
// Types
// ============================================================================

interface FeedStats {
  feedId: string;
  subscriptionId: string;
  title: string | null;
  customTitle: string | null;
  url: string | null;
  siteUrl: string | null;
  lastFetchedAt: Date | null;
  lastEntriesUpdatedAt: Date | null;
  nextFetchAt: Date | null;
  consecutiveFailures: number;
  lastError: string | null;
  websubActive: boolean;
  subscribedAt: Date;
  lastFetchEntryCount: number | null;
  lastFetchSizeBytes: number | null;
  totalEntryCount: number;
  entriesPerWeek: number | null;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Get status badge for feed
 */
function getStatusBadge(feed: FeedStats): { text: string; className: string } {
  if (feed.consecutiveFailures > 0) {
    return {
      text: `${feed.consecutiveFailures} failure${feed.consecutiveFailures === 1 ? "" : "s"}`,
      className: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300",
    };
  }
  if (feed.websubActive) {
    return {
      text: "WebSub Active",
      className: "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300",
    };
  }
  return {
    text: "OK",
    className: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300",
  };
}

// ============================================================================
// Main Component
// ============================================================================

export default function FeedStatsSettingsContent() {
  const loadMoreRef = useRef<HTMLDivElement>(null);

  const statsQuery = trpc.feedStats.list.useInfiniteQuery(
    { limit: PAGE_SIZE },
    {
      getNextPageParam: (lastPage) => lastPage.nextCursor,
    }
  );

  // Flatten all pages into a single list
  const feeds = useMemo(
    () => statsQuery.data?.pages.flatMap((page) => page.items) ?? [],
    [statsQuery.data?.pages]
  );

  // Calculate summary stats from all loaded feeds
  const totalFeeds = feeds.length;
  const healthyFeeds = feeds.filter((f) => f.consecutiveFailures === 0).length;
  const brokenFeeds = feeds.filter((f) => f.consecutiveFailures > 0).length;
  const websubFeeds = feeds.filter((f) => f.websubActive).length;

  // Intersection Observer for infinite scroll
  // Destructure before using in useCallback to satisfy React Compiler lint rule
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = statsQuery;
  const handleObserver = useCallback(
    (entries: IntersectionObserverEntry[]) => {
      const target = entries[0];
      if (target.isIntersecting && hasNextPage && !isFetchingNextPage) {
        fetchNextPage();
      }
    },
    [fetchNextPage, hasNextPage, isFetchingNextPage]
  );

  useEffect(() => {
    const observer = new IntersectionObserver(handleObserver, {
      rootMargin: "100px",
      threshold: 0,
    });

    const currentRef = loadMoreRef.current;
    if (currentRef) {
      observer.observe(currentRef);
    }

    return () => {
      if (currentRef) {
        observer.unobserve(currentRef);
      }
    };
  }, [handleObserver]);

  return (
    <div>
      {/* Page Header */}
      <div className="mb-6">
        <h2 className="ui-text-lg font-semibold text-zinc-900 dark:text-zinc-50">
          Feed Statistics
        </h2>
        <p className="ui-text-sm mt-1 text-zinc-600 dark:text-zinc-400">
          View fetch status and statistics for all your subscribed feeds.
        </p>
      </div>

      {/* Summary Stats */}
      {!statsQuery.isLoading && !statsQuery.error && feeds.length > 0 && (
        <div className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
          <SummaryCard label="Total Feeds" value={totalFeeds} />
          <SummaryCard label="Healthy" value={healthyFeeds} variant="success" />
          <SummaryCard label="Failing" value={brokenFeeds} variant="error" />
          <SummaryCard label="WebSub" value={websubFeeds} variant="info" />
        </div>
      )}

      {/* Feed Stats List */}
      <div className="rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
        {statsQuery.isLoading ? (
          <SettingsListSkeleton />
        ) : statsQuery.error ? (
          <div className="p-6">
            <Alert variant="error">Failed to load feed statistics. Please try again.</Alert>
          </div>
        ) : feeds.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="divide-y divide-zinc-200 dark:divide-zinc-800">
            {feeds.map((feed) => (
              <FeedStatsRow key={feed.subscriptionId} feed={feed} />
            ))}

            {/* Load more trigger element */}
            <div ref={loadMoreRef} className="h-1" />

            {/* Loading indicator */}
            {statsQuery.isFetchingNextPage && (
              <div className="flex items-center justify-center p-4">
                <SpinnerIcon className="mr-2 h-4 w-4 text-zinc-400" />
                <span className="ui-text-sm text-zinc-500 dark:text-zinc-400">Loading more...</span>
              </div>
            )}

            {/* End of list */}
            {!statsQuery.hasNextPage && feeds.length > 0 && (
              <p className="ui-text-xs p-3 text-center text-zinc-400 dark:text-zinc-500">
                All feeds loaded
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================================
// Summary Card
// ============================================================================

interface SummaryCardProps {
  label: string;
  value: number;
  variant?: "default" | "success" | "error" | "info";
}

function SummaryCard({ label, value, variant = "default" }: SummaryCardProps) {
  const variantClasses = {
    default: "text-zinc-900 dark:text-zinc-50",
    success: "text-green-600 dark:text-green-400",
    error: "text-red-600 dark:text-red-400",
    info: "text-purple-600 dark:text-purple-400",
  };

  return (
    <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-700 dark:bg-zinc-800">
      <p className="ui-text-sm text-zinc-500 dark:text-zinc-400">{label}</p>
      <p className={`ui-text-2xl font-semibold ${variantClasses[variant]}`}>{value}</p>
    </div>
  );
}

// ============================================================================
// Empty State
// ============================================================================

function EmptyState() {
  return (
    <div className="p-8 text-center">
      <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-zinc-100 dark:bg-zinc-800">
        <RssIcon className="h-6 w-6 text-zinc-400 dark:text-zinc-500" />
      </div>
      <h3 className="ui-text-sm mt-4 font-medium text-zinc-900 dark:text-zinc-50">
        No feeds subscribed
      </h3>
      <p className="ui-text-sm mt-1 text-zinc-500 dark:text-zinc-400">
        Subscribe to some feeds to see their statistics here.
      </p>
    </div>
  );
}

// ============================================================================
// Feed Stats Row
// ============================================================================

interface FeedStatsRowProps {
  feed: FeedStats;
}

function FeedStatsRow({ feed }: FeedStatsRowProps) {
  const displayName = getFeedDisplayName(feed);
  const statusBadge = getStatusBadge(feed);

  return (
    <div className="p-4">
      {/* Main Row Content */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          {/* Feed Title and Status */}
          <div className="flex items-center gap-2">
            <p className="font-medium text-zinc-900 dark:text-zinc-50">{displayName}</p>
            <span
              className={`ui-text-xs inline-flex items-center rounded-full px-2 py-0.5 font-medium ${statusBadge.className}`}
            >
              {statusBadge.text}
            </span>
          </div>

          {/* Feed URL */}
          {feed.url && (
            <p className="ui-text-sm mt-0.5 truncate text-zinc-500 dark:text-zinc-400">
              {feed.url}
            </p>
          )}

          {/* Error Message (if any) */}
          {feed.lastError && (
            <div className="mt-2 rounded-md bg-red-50 px-3 py-2 dark:bg-red-900/20">
              <p className="ui-text-sm text-red-700 dark:text-red-300">
                <span className="font-medium">Error:</span> {feed.lastError}
              </p>
            </div>
          )}

          {/* Stats Grid - Fetch timing */}
          <div className="ui-text-sm mt-3 grid grid-cols-3 gap-x-6 gap-y-2">
            <StatItem
              icon={<ClockIcon />}
              label="Last fetch"
              value={
                feed.lastFetchedAt ? formatRelativeTime(new Date(feed.lastFetchedAt)) : "Never"
              }
            />
            <StatItem
              icon={<CalendarIcon />}
              label="Next fetch"
              value={formatFutureTime(feed.nextFetchAt)}
            />
            <StatItem
              icon={<RefreshIcon />}
              label="Last update"
              value={
                feed.lastEntriesUpdatedAt
                  ? formatRelativeTime(new Date(feed.lastEntriesUpdatedAt))
                  : "Never"
              }
            />
          </div>

          {/* Stats Grid - Entry and size stats */}
          <div className="ui-text-sm mt-2 grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-4">
            <StatItem
              icon={<DocumentIcon />}
              label="Total entries"
              value={String(feed.totalEntryCount)}
            />
            <StatItem
              icon={<DocumentIcon />}
              label="Entries/week"
              value={feed.entriesPerWeek != null ? feed.entriesPerWeek.toFixed(1) : "--"}
            />
            <StatItem
              icon={<DocumentIcon />}
              label="Last fetch size"
              value={formatBytes(feed.lastFetchSizeBytes)}
            />
            <StatItem
              icon={<DocumentIcon />}
              label="Last fetch entries"
              value={feed.lastFetchEntryCount != null ? String(feed.lastFetchEntryCount) : "--"}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Stat Item
// ============================================================================

interface StatItemProps {
  icon: React.ReactNode;
  label: string;
  value: string;
}

function StatItem({ icon, label, value }: StatItemProps) {
  return (
    <div className="flex items-center gap-1.5 text-zinc-500 dark:text-zinc-400">
      <span className="h-4 w-4 shrink-0">{icon}</span>
      <span className="truncate">
        <span className="font-medium text-zinc-700 dark:text-zinc-300">{label}:</span> {value}
      </span>
    </div>
  );
}

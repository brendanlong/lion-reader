/**
 * Feed Stats Settings Page
 *
 * Displays fetch statistics for all subscribed feeds including
 * last fetch time, next scheduled fetch, error states, and WebSub status.
 */

"use client";

import { trpc } from "@/lib/trpc/client";
import { Alert } from "@/components/ui";

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
function getFeedDisplayName(feed: FeedStats): string {
  if (feed.customTitle) return feed.customTitle;
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

export default function FeedStatsPage() {
  const statsQuery = trpc.feedStats.list.useQuery();

  const feeds = statsQuery.data?.items ?? [];

  // Calculate summary stats
  const totalFeeds = feeds.length;
  const healthyFeeds = feeds.filter((f) => f.consecutiveFailures === 0).length;
  const brokenFeeds = feeds.filter((f) => f.consecutiveFailures > 0).length;
  const websubFeeds = feeds.filter((f) => f.websubActive).length;

  return (
    <div>
      {/* Page Header */}
      <div className="mb-6">
        <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">Feed Statistics</h2>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
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
          <div className="p-6">
            {[1, 2, 3].map((i) => (
              <div
                key={i}
                className="mb-4 h-24 animate-pulse rounded bg-zinc-100 last:mb-0 dark:bg-zinc-800"
              />
            ))}
          </div>
        ) : statsQuery.error ? (
          <div className="p-6">
            <Alert variant="error">Failed to load feed statistics. Please try again.</Alert>
          </div>
        ) : feeds.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="divide-y divide-zinc-200 dark:divide-zinc-800">
            {feeds.map((feed) => (
              <FeedStatsRow key={feed.feedId} feed={feed} />
            ))}
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
      <p className="text-sm text-zinc-500 dark:text-zinc-400">{label}</p>
      <p className={`text-2xl font-semibold ${variantClasses[variant]}`}>{value}</p>
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
        <svg
          className="h-6 w-6 text-zinc-400 dark:text-zinc-500"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M6 5c7.18 0 13 5.82 13 13M6 11a7 7 0 017 7m-6 0a1 1 0 11-2 0 1 1 0 012 0z"
          />
        </svg>
      </div>
      <h3 className="mt-4 text-sm font-medium text-zinc-900 dark:text-zinc-50">
        No feeds subscribed
      </h3>
      <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
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
              className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${statusBadge.className}`}
            >
              {statusBadge.text}
            </span>
          </div>

          {/* Feed URL */}
          {feed.url && (
            <p className="mt-0.5 truncate text-sm text-zinc-500 dark:text-zinc-400">{feed.url}</p>
          )}

          {/* Error Message (if any) */}
          {feed.lastError && (
            <div className="mt-2 rounded-md bg-red-50 px-3 py-2 dark:bg-red-900/20">
              <p className="text-sm text-red-700 dark:text-red-300">
                <span className="font-medium">Error:</span> {feed.lastError}
              </p>
            </div>
          )}

          {/* Stats Grid */}
          <div className="mt-3 grid grid-cols-3 gap-x-6 gap-y-2 text-sm">
            <StatItem
              icon={<ClockIcon />}
              label="Last fetch"
              value={formatRelativeDate(feed.lastFetchedAt)}
            />
            <StatItem
              icon={<CalendarIcon />}
              label="Next fetch"
              value={formatFutureDate(feed.nextFetchAt)}
            />
            <StatItem
              icon={<RefreshIcon />}
              label="Last update"
              value={formatRelativeDate(feed.lastEntriesUpdatedAt)}
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

// ============================================================================
// Icons
// ============================================================================

function ClockIcon() {
  return (
    <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
      />
    </svg>
  );
}

function CalendarIcon() {
  return (
    <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
      />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
      />
    </svg>
  );
}

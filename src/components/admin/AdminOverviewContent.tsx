/**
 * Admin Overview Content
 *
 * Displays system-wide statistics: user counts, feed counts, entries,
 * active users, and other health metrics.
 */

"use client";

import { trpc } from "@/lib/trpc/client";
import { Button } from "@/components/ui/button";
import { SpinnerIcon } from "@/components/ui/icon-button";

// ============================================================================
// Stat Card
// ============================================================================

function StatCard({
  label,
  value,
  detail,
}: {
  label: string;
  value: string | number;
  detail?: string;
}) {
  return (
    <div className="border-edge bg-surface rounded-lg border p-4">
      <p className="ui-text-xs text-muted">{label}</p>
      <p className="ui-text-lg text-strong mt-1 font-semibold">
        {typeof value === "number" ? value.toLocaleString() : value}
      </p>
      {detail && <p className="ui-text-xs text-faint mt-1">{detail}</p>}
    </div>
  );
}

// ============================================================================
// Main Component
// ============================================================================

export default function AdminOverviewContent() {
  const overviewQuery = trpc.admin.getOverview.useQuery();

  if (overviewQuery.isLoading) {
    return (
      <div className="flex items-center justify-center p-8">
        <SpinnerIcon className="text-faint h-6 w-6" />
      </div>
    );
  }

  if (overviewQuery.isError) {
    return (
      <div className="p-8 text-center">
        <p className="ui-text-sm text-danger">Failed to load overview. Please try again.</p>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => overviewQuery.refetch()}
          className="mt-2"
        >
          Retry
        </Button>
      </div>
    );
  }

  const data = overviewQuery.data!;

  return (
    <div>
      <div className="mb-6">
        <h2 className="ui-text-lg text-strong font-semibold">Overview</h2>
      </div>

      {/* Users */}
      <h3 className="ui-text-sm text-body mb-3 font-medium">Users</h3>
      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard label="Total Users" value={data.totalUsers} />
        <StatCard label="Active (7 days)" value={data.activeUsersLast7Days} />
        <StatCard label="Active (30 days)" value={data.activeUsersLast30Days} />
      </div>

      {/* Feeds */}
      <h3 className="ui-text-sm text-body mb-3 font-medium">Feeds</h3>
      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard label="Total Feeds" value={data.totalFeeds} />
        <StatCard
          label="With Subscribers"
          value={data.totalFeedsWithSubscribers}
          detail={`${data.totalFeeds - data.totalFeedsWithSubscribers} orphaned`}
        />
        <StatCard
          label="Broken Feeds"
          value={data.brokenFeeds}
          detail={data.brokenFeeds > 0 ? "Have consecutive failures" : "All healthy"}
        />
      </div>

      {/* Content & Activity */}
      <h3 className="ui-text-sm text-body mb-3 font-medium">Content & Activity</h3>
      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard label="Total Entries" value={data.totalEntries} />
        <StatCard label="Active Subscriptions" value={data.totalSubscriptions} />
        <StatCard label="Pending Invites" value={data.pendingInvites} />
      </div>
    </div>
  );
}

/**
 * System-wide totals for the admin overview.
 */

import { and, count, gt, isNull, sql } from "drizzle-orm";
import type { Database } from "@/server/db";
import { feeds, invites, subscriptions, users } from "@/server/db/schema";
import { isUserManagedSubscription, isWebSubscription } from "@/server/services/subscriptions";

interface AdminOverview {
  totalUsers: number;
  activeUsersLast7Days: number;
  activeUsersLast30Days: number;
  totalFeeds: number;
  totalFeedsWithSubscribers: number;
  brokenFeeds: number;
  /**
   * The planner's row estimate, kept current by autovacuum/ANALYZE: an exact
   * count(*) reads every entry. NULL until the table is first analyzed.
   */
  estimatedEntries: number | null;
  totalSubscriptions: number;
  pendingInvites: number;
}

export async function getAdminOverview(db: Database): Promise<AdminOverview> {
  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  // Run counts in parallel, combining queries that scan the same table
  const [
    totalUsersResult,
    activeUsersResult,
    feedStatsResult,
    feedsWithSubsResult,
    estimatedEntriesResult,
    totalSubscriptionsResult,
    pendingInvitesResult,
  ] = await Promise.all([
    // Total users
    db.select({ count: count() }).from(users),

    // Active users: single scan over the denormalized users.last_active_at
    // (durable across session retention cleanup, unlike a sessions scan).
    // This counts real reader activity only — Google Reader compat-API
    // polling is a scoped session that never bumps users.last_active_at, so
    // native-app-only users don't inflate these counts (see
    // updateLastActiveAt).
    db
      .select({
        active7d: sql<number>`COUNT(*) FILTER (WHERE ${users.lastActiveAt} > ${sevenDaysAgo})`,
        // No FILTER needed: the WHERE below already restricts the scan to
        // the 30-day window (and `gt` excludes NULL last_active_at).
        active30d: count(),
      })
      .from(users)
      .where(gt(users.lastActiveAt, thirtyDaysAgo)),

    // Feed stats: single scan for total and broken counts
    db
      .select({
        total: count(),
        broken: sql<number>`COUNT(*) FILTER (WHERE ${feeds.consecutiveFailures} > 0)`,
      })
      .from(feeds),

    // Web feeds with at least one active subscriber
    db
      .select({ count: sql<number>`COUNT(DISTINCT ${subscriptions.feedId})` })
      .from(subscriptions)
      .where(and(isNull(subscriptions.unsubscribedAt), isWebSubscription())),

    // reltuples is -1 before the first ANALYZE.
    db.execute<{ estimate: string | null }>(
      sql`SELECT NULLIF(reltuples, -1)::bigint AS estimate FROM pg_class WHERE oid = 'entries'::regclass`
    ),

    // Total active subscriptions
    db
      .select({ count: count() })
      .from(subscriptions)
      .where(and(isNull(subscriptions.unsubscribedAt), isUserManagedSubscription())),

    // Pending invites
    db
      .select({ count: count() })
      .from(invites)
      .where(and(isNull(invites.usedAt), gt(invites.expiresAt, now))),
  ]);

  return {
    totalUsers: Number(totalUsersResult[0].count),
    activeUsersLast7Days: Number(activeUsersResult[0].active7d),
    activeUsersLast30Days: Number(activeUsersResult[0].active30d),
    totalFeeds: Number(feedStatsResult[0].total),
    totalFeedsWithSubscribers: Number(feedsWithSubsResult[0].count),
    brokenFeeds: Number(feedStatsResult[0].broken),
    estimatedEntries:
      estimatedEntriesResult.rows[0].estimate === null
        ? null
        : Number(estimatedEntriesResult.rows[0].estimate),
    totalSubscriptions: Number(totalSubscriptionsResult[0].count),
    pendingInvites: Number(pendingInvitesResult[0].count),
  };
}

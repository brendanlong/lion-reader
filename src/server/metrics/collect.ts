/**
 * Business Metrics Collection
 *
 * Collects metrics from the database for Prometheus export.
 * These are called on-demand when the /api/metrics endpoint is hit.
 */

import { sql } from "drizzle-orm";
import { db } from "../db";
import { users, subscriptions, entries, feeds, jobs } from "../db/schema";
import { metricsEnabled, updateBusinessMetrics, updateJobQueueMetrics } from "./metrics";

/**
 * Collects and updates all business metrics from the database.
 * This function has zero overhead when metrics are disabled.
 */
async function collectBusinessMetrics(): Promise<void> {
  if (!metricsEnabled) return;

  // Collect all counts in parallel for efficiency
  const [userCount, subscriptionCount, entryCount, feedCount] = await Promise.all([
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(users)
      .then((rows) => rows[0]?.count ?? 0),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(subscriptions)
      .where(sql`${subscriptions.unsubscribedAt} IS NULL`)
      .then((rows) => rows[0]?.count ?? 0),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(entries)
      .then((rows) => rows[0]?.count ?? 0),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(feeds)
      .then((rows) => rows[0]?.count ?? 0),
  ]);

  updateBusinessMetrics({
    users: userCount,
    subscriptions: subscriptionCount,
    entries: entryCount,
    feeds: feedCount,
  });
}

/**
 * Collects and updates job queue size metrics from the database.
 * This function has zero overhead when metrics are disabled.
 */
async function collectJobQueueMetrics(): Promise<void> {
  if (!metricsEnabled) return;

  // Count jobs by type and status
  // In the new schema: enabled=true jobs are "pending", running_since IS NOT NULL are "running"
  const pendingCounts = await db
    .select({
      type: jobs.type,
      count: sql<number>`count(*)::int`,
    })
    .from(jobs)
    .where(sql`${jobs.enabled} = true AND ${jobs.runningSince} IS NULL`)
    .groupBy(jobs.type);

  const runningCounts = await db
    .select({
      type: jobs.type,
      count: sql<number>`count(*)::int`,
    })
    .from(jobs)
    .where(sql`${jobs.runningSince} IS NOT NULL`)
    .groupBy(jobs.type);

  const jobCounts = [
    ...pendingCounts.map((row) => ({
      type: row.type,
      status: "pending" as const,
      count: row.count,
    })),
    ...runningCounts.map((row) => ({
      type: row.type,
      status: "running" as const,
      count: row.count,
    })),
  ];

  updateJobQueueMetrics(jobCounts);
}

/**
 * Collects all metrics before returning them.
 * Called by the /api/metrics endpoint to ensure metrics are up-to-date.
 */
export async function collectAllMetrics(): Promise<void> {
  if (!metricsEnabled) return;

  await Promise.all([collectBusinessMetrics(), collectJobQueueMetrics()]);
}

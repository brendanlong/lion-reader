/**
 * Business Metrics Collection
 *
 * Collects metrics from the database for Prometheus export.
 * These are called on-demand when the /api/metrics endpoint is hit.
 */

import { sql, type SQL } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { db, pool } from "../db";
import { users, subscriptions, entries, feeds, jobs } from "../db/schema";
import {
  metricsEnabled,
  updateBusinessMetrics,
  updateJobQueueMetrics,
  updateDbPoolMetrics,
} from "./metrics";

function countRows(table: PgTable, where?: SQL): Promise<number> {
  return db
    .select({ count: sql<number>`count(*)::int` })
    .from(table)
    .where(where)
    .then((rows) => rows[0]?.count ?? 0);
}

/**
 * Collects and updates all business metrics from the database.
 */
async function collectBusinessMetrics(): Promise<void> {
  const [userCount, subscriptionCount, entryCount, feedCount] = await Promise.all([
    countRows(users),
    countRows(subscriptions, sql`${subscriptions.unsubscribedAt} IS NULL`),
    countRows(entries),
    countRows(feeds),
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
 * Pending: jobs not currently running; running: `running_since IS NOT NULL`.
 */
async function collectJobQueueMetrics(): Promise<void> {
  const status = sql<string>`CASE WHEN ${jobs.runningSince} IS NULL THEN 'pending' ELSE 'running' END`;
  const counts = await db
    .select({ type: jobs.type, status, count: sql<number>`count(*)::int` })
    .from(jobs)
    .groupBy(jobs.type, status);

  updateJobQueueMetrics(counts);
}

/**
 * Collects database connection pool metrics.
 * These are synchronous reads from the pg Pool object.
 */
function collectPoolMetrics(): void {
  updateDbPoolMetrics({
    totalCount: pool.totalCount,
    idleCount: pool.idleCount,
    waitingCount: pool.waitingCount,
  });
}

/**
 * Collects all metrics before returning them.
 * Called by the /api/metrics endpoint to ensure metrics are up-to-date.
 */
export async function collectAllMetrics(): Promise<void> {
  if (!metricsEnabled) return;

  collectPoolMetrics();
  await Promise.all([collectBusinessMetrics(), collectJobQueueMetrics()]);
}

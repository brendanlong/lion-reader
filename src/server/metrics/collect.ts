/**
 * Business Metrics Collection
 *
 * Collects metrics from the database for Prometheus export, on each scrape.
 */

import { getTableName, sql, type SQL } from "drizzle-orm";
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

// entries grows without bound, so it uses the planner's row estimate instead of
// a count(*) scan per scrape. reltuples lives in the catalog, so unlike the
// cumulative stats (n_live_tup) it survives a crash or failover; vacuum and
// analyze keep it current. It's -1 until the table is first analyzed.
function estimateRows(table: PgTable): Promise<number> {
  return db
    .execute<{ estimate: number }>(
      sql`SELECT GREATEST(reltuples, 0)::float8 AS estimate FROM pg_class WHERE oid = ${getTableName(table)}::regclass`
    )
    .then((result) => result.rows[0]?.estimate ?? 0);
}

/**
 * Collects and updates all business metrics from the database.
 */
async function collectBusinessMetrics(): Promise<void> {
  const [userCount, subscriptionCount, entryCount, feedCount] = await Promise.all([
    countRows(users),
    countRows(subscriptions, sql`${subscriptions.unsubscribedAt} IS NULL`),
    estimateRows(entries),
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
 * Collects all metrics before a scrape. Database-wide gauges are the same from
 * every process, so only one process (the worker) queries them; otherwise each
 * scrape runs the queries once per machine and the series are duplicated.
 */
export async function collectAllMetrics(includeDatabaseMetrics: boolean): Promise<void> {
  if (!metricsEnabled) return;

  collectPoolMetrics();
  if (includeDatabaseMetrics) {
    await Promise.all([collectBusinessMetrics(), collectJobQueueMetrics()]);
  }
}

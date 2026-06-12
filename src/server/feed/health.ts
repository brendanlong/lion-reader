/**
 * Feed fetch health monitoring.
 *
 * Implements the invariant "at least one feed must fetch successfully every N
 * minutes": in steady state web feeds are polled at least hourly (scheduling
 * minimum), so if no feed at all has fetched successfully recently, fetching is
 * broken globally (worker stuck, fetch/parse pipeline regression, network
 * egress failure) rather than individual feeds misbehaving.
 *
 * The snapshot/evaluation split keeps the decision logic pure and unit-testable;
 * the periodic monitor_feed_health job (src/server/jobs/handlers.ts) takes a
 * snapshot, evaluates it, and alerts on status transitions.
 */

import { sql } from "drizzle-orm";
import { db as defaultDb } from "../db";

/**
 * Snapshot of feed fetch health state from the database.
 */
export interface FeedFetchHealthSnapshot {
  /** Number of web feeds with at least one active subscriber (i.e. feeds the worker polls). */
  pollableFeedCount: number;
  /**
   * Most recent successful fetch across pollable feeds. A feed's last_fetched_at
   * counts only while its last_error is NULL: any failure (HTTP, parse, network)
   * sets last_error, so this value freezes when fetching breaks globally.
   */
  lastSuccessfulFetchAt: Date | null;
  /** Number of pollable feeds currently failing (consecutive_failures > 0). */
  failingFeedCount: number;
  /** last_error from the most recently fetched feed that has one, for alert context. */
  sampleError: string | null;
}

/**
 * Reads the current feed fetch health snapshot.
 */
export async function getFeedFetchHealthSnapshot(
  db: typeof defaultDb = defaultDb
): Promise<FeedFetchHealthSnapshot> {
  const result = await db.execute<{
    pollable_feed_count: number;
    last_successful_fetch_at: string | null;
    failing_feed_count: number;
    sample_error: string | null;
  }>(sql`
    WITH pollable AS (
      SELECT f.id, f.last_fetched_at, f.last_error, f.consecutive_failures
      FROM feeds f
      WHERE f.type = 'web'
        AND EXISTS (
          SELECT 1 FROM subscriptions s
          WHERE s.feed_id = f.id AND s.unsubscribed_at IS NULL
        )
    )
    SELECT
      count(*)::int AS pollable_feed_count,
      max(last_fetched_at) FILTER (WHERE last_error IS NULL) AS last_successful_fetch_at,
      count(*) FILTER (WHERE consecutive_failures > 0)::int AS failing_feed_count,
      (SELECT last_error FROM pollable
        WHERE last_error IS NOT NULL
        ORDER BY last_fetched_at DESC NULLS LAST
        LIMIT 1) AS sample_error
    FROM pollable
  `);

  const row = result.rows[0];
  return {
    pollableFeedCount: row.pollable_feed_count,
    lastSuccessfulFetchAt: row.last_successful_fetch_at
      ? new Date(row.last_successful_fetch_at)
      : null,
    failingFeedCount: row.failing_feed_count,
    sampleError: row.sample_error,
  };
}

export type FeedFetchHealthStatus = "healthy" | "unhealthy";

/**
 * Result of evaluating a health snapshot.
 */
export interface FeedFetchHealthEvaluation {
  status: FeedFetchHealthStatus;
  /** Human-readable explanation, used in alerts and logs. */
  reason: string;
  /** Age of the most recent successful fetch, or null if there has never been one. */
  lastSuccessAgeMs: number | null;
}

/**
 * Evaluates a health snapshot against the maximum allowed successful-fetch age.
 *
 * Pure function (no I/O) so the alerting rule itself is unit-testable.
 *
 * - No pollable feeds: healthy (nothing to fetch, nothing can be broken).
 * - No successful fetch ever, but pollable feeds exist: unhealthy (new feeds
 *   are fetched within minutes of subscribing, so a persistent null means
 *   fetching never works).
 * - Most recent success older than maxSuccessAgeMs: unhealthy.
 */
export function evaluateFeedFetchHealth(
  snapshot: FeedFetchHealthSnapshot,
  now: Date,
  maxSuccessAgeMs: number
): FeedFetchHealthEvaluation {
  if (snapshot.pollableFeedCount === 0) {
    return {
      status: "healthy",
      reason: "No pollable feeds",
      lastSuccessAgeMs: null,
    };
  }

  if (snapshot.lastSuccessfulFetchAt === null) {
    return {
      status: "unhealthy",
      reason: `No feed has ever fetched successfully (${snapshot.pollableFeedCount} pollable feeds)`,
      lastSuccessAgeMs: null,
    };
  }

  const ageMs = now.getTime() - snapshot.lastSuccessfulFetchAt.getTime();
  if (ageMs > maxSuccessAgeMs) {
    const ageMinutes = Math.round(ageMs / 60_000);
    return {
      status: "unhealthy",
      reason: `No successful feed fetch in ${ageMinutes} minutes (threshold: ${Math.round(maxSuccessAgeMs / 60_000)} minutes)`,
      lastSuccessAgeMs: ageMs,
    };
  }

  return {
    status: "healthy",
    reason: "Recent successful feed fetch",
    lastSuccessAgeMs: ageMs,
  };
}

/**
 * Builds the healthchecks.io ping body for a feed-health check run. This text
 * is included in the monitor's notification emails, so it must explain *why*
 * the check is failing without needing to open the app.
 */
export function buildFeedHealthPingBody(
  snapshot: FeedFetchHealthSnapshot,
  evaluation: FeedFetchHealthEvaluation
): string {
  const lines = [
    `Status: ${evaluation.status}`,
    evaluation.reason,
    `Last successful fetch: ${snapshot.lastSuccessfulFetchAt?.toISOString() ?? "never"}`,
    `Failing feeds: ${snapshot.failingFeedCount} / ${snapshot.pollableFeedCount}`,
  ];
  if (snapshot.sampleError) {
    lines.push(`Most recent feed error: ${snapshot.sampleError}`);
  }
  return lines.join("\n");
}

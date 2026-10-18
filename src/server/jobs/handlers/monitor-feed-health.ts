/**
 * Handler for `monitor_feed_health` jobs (fixed-interval singleton).
 *
 * See src/server/feed/health.ts for the invariant this checks.
 */

import {
  getFeedFetchHealthSnapshot,
  evaluateFeedFetchHealth,
  buildFeedHealthPingBody,
} from "../../feed/health";
import { pingHealthcheck } from "../../notifications/healthchecks";
import { feedHealthConfig } from "../../config/env";
import { updateFeedHealthMetrics } from "../../metrics/metrics";
import { logger } from "@/lib/logger";
import type { JobMetadata } from "./types";

/**
 * Checks the invariant "at least one feed fetched successfully recently"
 * (see src/server/feed/health.ts) and:
 * - Pings the configured healthchecks.io check (FEED_HEALTH_HEARTBEAT_URL):
 *   a success ping when healthy, a `/fail` ping with an explanatory body when
 *   not. This is the feed-fetch *quality* signal; the worker process's own
 *   liveness is a separate check (WORKER_HEARTBEAT_URL, see scripts/worker.ts),
 *   so "feeds are failing" stays distinguishable from "worker is dead".
 * - Updates the feed health Prometheus gauges.
 *
 * No alert state is kept here: healthchecks.io de-duplicates notifications and
 * sends its own recovery ("up") email, so the job just reports status each run.
 */
export async function handleMonitorFeedHealth(): Promise<JobMetadata> {
  const now = new Date();
  const snapshot = await getFeedFetchHealthSnapshot();
  const evaluation = evaluateFeedFetchHealth(
    snapshot,
    now,
    feedHealthConfig.maxSuccessAgeMinutes * 60 * 1000
  );

  updateFeedHealthMetrics(
    evaluation.lastSuccessAgeMs !== null ? evaluation.lastSuccessAgeMs / 1000 : null,
    snapshot.failingFeedCount
  );

  if (evaluation.status === "unhealthy") {
    logger.warn("Feed fetch health check failed", {
      reason: evaluation.reason,
      lastSuccessfulFetchAt: snapshot.lastSuccessfulFetchAt?.toISOString(),
      failingFeedCount: snapshot.failingFeedCount,
      pollableFeedCount: snapshot.pollableFeedCount,
      sampleError: snapshot.sampleError,
    });
  }

  if (feedHealthConfig.heartbeatUrl) {
    await pingHealthcheck(feedHealthConfig.heartbeatUrl, {
      signal: evaluation.status === "healthy" ? "success" : "fail",
      body: buildFeedHealthPingBody(snapshot, evaluation),
    });
  }

  return {
    status: evaluation.status,
    reason: evaluation.reason,
    lastSuccessAgeMs: evaluation.lastSuccessAgeMs ?? undefined,
    failingFeedCount: snapshot.failingFeedCount,
    pollableFeedCount: snapshot.pollableFeedCount,
  };
}

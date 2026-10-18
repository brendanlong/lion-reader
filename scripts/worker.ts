/**
 * Standalone background worker process.
 *
 * This script runs the job worker as a separate process from the API server,
 * allowing independent scaling and resource management.
 *
 * Usage:
 *   pnpm worker
 *   # or with nice for lower CPU priority:
 *   nice -n 10 pnpm worker
 *
 * Environment variables:
 *   WORKER_POLL_INTERVAL_MS - Polling interval in ms (default: DEFAULT_POLL_INTERVAL_MS)
 *   WORKER_CONCURRENCY - Max concurrent jobs (default: DEFAULT_CONCURRENCY)
 *   WORKER_HEARTBEAT_URL - Optional healthchecks.io check for the loop's liveness
 */

import {
  DEFAULT_CONCURRENCY,
  DEFAULT_POLL_INTERVAL_MS,
  createWorker,
  type Worker,
} from "../src/server/jobs/worker";
import type { WorkerStats } from "../src/server/jobs/worker-core";
import { runProcess } from "../src/server/process";
import { logger } from "../src/lib/logger";

const pollIntervalMs = parseInt(
  process.env.WORKER_POLL_INTERVAL_MS ?? String(DEFAULT_POLL_INTERVAL_MS),
  10
);
const concurrency = parseInt(process.env.WORKER_CONCURRENCY ?? String(DEFAULT_CONCURRENCY), 10);

/**
 * How long the worker loop can be inactive before the health check reports unhealthy.
 * This should be longer than the job timeout (5 min) to avoid false positives.
 * Set to 10 minutes: enough time for a job to time out + cleanup.
 */
const LIVENESS_THRESHOLD_MS = 10 * 60 * 1000;

/** How often to ping the worker liveness healthchecks.io check. */
const WORKER_HEARTBEAT_INTERVAL_MS = 60 * 1000;

/**
 * The worker loop's liveness, shared by the Fly health check and the
 * healthchecks.io heartbeat so both judge staleness the same way.
 */
function checkLoopLiveness(worker: Worker): {
  stale: boolean;
  staleDurationMs: number;
  stats: WorkerStats;
} {
  const stats = worker.getStats();
  const staleDurationMs = Date.now() - stats.lastActivityAt.getTime();
  return { stale: staleDurationMs > LIVENESS_THRESHOLD_MS, staleDurationMs, stats };
}

runProcess({
  name: "standalone worker",
  metricsPort: 9092,
  includeDatabaseMetrics: true,
  details: { pollIntervalMs, concurrency },
  // Separate from the feed-health check so "worker process is alive and its
  // loop is running" is a distinct signal from "feeds are fetching
  // successfully": a stuck/dead worker shows here even when there's no
  // feed-fetch regression.
  heartbeat: { url: process.env.WORKER_HEARTBEAT_URL, intervalMs: WORKER_HEARTBEAT_INTERVAL_MS },
  start: async (fail) => {
    const worker = createWorker({
      pollIntervalMs,
      concurrency,
      // The run loop should never exit on its own. If it does, the process is a
      // zombie (alive but claiming no jobs), so exit non-zero and let Fly
      // restart the machine — a clean restart beats lingering with a dead loop
      // until the liveness health check eventually trips.
      onLoopExit: (error) => {
        logger.error("Worker run loop exited; restarting process", {
          error: error instanceof Error ? error.message : "Unknown error",
        });
        fail("worker run loop exited");
      },
    });
    await worker.start();

    return {
      // Stops claiming and waits for in-flight jobs. A job still running when
      // the drain times out is abandoned with its lease, and retried once the
      // lease goes stale.
      stop: () => worker.stop(),
      checkHealth: () => {
        const { stale, staleDurationMs, stats } = checkLoopLiveness(worker);
        if (stale) {
          return {
            status: "unhealthy",
            details: {
              reason: "worker_loop_stale",
              lastActivityAt: stats.lastActivityAt.toISOString(),
              staleDurationMs,
              thresholdMs: LIVENESS_THRESHOLD_MS,
              activeJobs: stats.activeJobs,
            },
          };
        }
        return {
          status: "healthy",
          details: {
            activeJobs: stats.activeJobs,
            totalProcessed: stats.totalProcessed,
            lastActivityAt: stats.lastActivityAt.toISOString(),
          },
        };
      },
      // Reports /fail if the loop wedges instead of going silent.
      heartbeatStatus: () => {
        const { stale, staleDurationMs, stats } = checkLoopLiveness(worker);
        if (stale) {
          return {
            signal: "fail",
            body: `Worker loop stale for ${Math.round(staleDurationMs / 1000)}s (threshold ${LIVENESS_THRESHOLD_MS / 1000}s); activeJobs=${stats.activeJobs}`,
          };
        }
        return {
          body: `Worker alive: activeJobs=${stats.activeJobs} processed=${stats.totalProcessed} lastActivity=${stats.lastActivityAt.toISOString()}`,
        };
      },
    };
  },
});

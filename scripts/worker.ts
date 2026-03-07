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
 *   WORKER_POLL_INTERVAL_MS - Polling interval in ms (default: 5000)
 *   WORKER_CONCURRENCY - Max concurrent jobs (default: 3)
 */

import { startWorkerWithSignalHandling } from "../src/server/jobs/worker";
import { startMetricsServer, setHealthChecker } from "../src/server/metrics/server";
import { notifyWorkerStarted } from "../src/server/notifications/discord-webhook";
import { logger } from "../src/lib/logger";

const pollIntervalMs = parseInt(process.env.WORKER_POLL_INTERVAL_MS ?? "5000", 10);
const concurrency = parseInt(process.env.WORKER_CONCURRENCY ?? "3", 10);

/**
 * How long the worker loop can be inactive before the health check reports unhealthy.
 * This should be longer than the job timeout (5 min) to avoid false positives.
 * Set to 10 minutes: enough time for a job to time out + cleanup.
 */
const LIVENESS_THRESHOLD_MS = 10 * 60 * 1000;

logger.info("Starting standalone worker", {
  pollIntervalMs,
  concurrency,
  pid: process.pid,
});

// Start internal metrics server on port 9092 (separate from Next.js on 9091)
startMetricsServer(9092);

// Notify about worker start (helps detect crash loops)
notifyWorkerStarted({ processType: "worker" }).catch((error) => {
  // Don't let notification failures prevent worker from starting
  logger.warn("Failed to send worker start notification", { error });
});

startWorkerWithSignalHandling({
  pollIntervalMs,
  concurrency,
})
  .then((worker) => {
    logger.info("Worker started successfully");

    // Register liveness health checker now that the worker is running.
    // Fly.io will restart the machine if /health returns 503.
    setHealthChecker(() => {
      const stats = worker.getStats();
      const staleDurationMs = Date.now() - stats.lastActivityAt.getTime();

      if (staleDurationMs > LIVENESS_THRESHOLD_MS) {
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
    });
  })
  .catch((error) => {
    logger.error("Failed to start worker", { error });
    process.exit(1);
  });

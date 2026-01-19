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
import { startMetricsServer } from "../src/server/metrics/server";
import { logger } from "../src/lib/logger";

const pollIntervalMs = parseInt(process.env.WORKER_POLL_INTERVAL_MS ?? "5000", 10);
const concurrency = parseInt(process.env.WORKER_CONCURRENCY ?? "3", 10);

logger.info("Starting standalone worker", {
  pollIntervalMs,
  concurrency,
  pid: process.pid,
});

// Start internal metrics server on port 9092 (separate from Next.js on 9091)
startMetricsServer(9092);

startWorkerWithSignalHandling({
  pollIntervalMs,
  concurrency,
})
  .then(() => {
    logger.info("Worker started successfully");
  })
  .catch((error) => {
    logger.error("Failed to start worker", { error });
    process.exit(1);
  });

/**
 * Background worker for processing jobs from the queue.
 *
 * Features:
 * - Event-driven job processing with Promise.race for efficient slot management
 * - Immediately fills slots when jobs complete (no polling delay)
 * - Falls back to polling when queue is empty
 * - Supports concurrent job processing up to configurable limit
 * - Graceful shutdown on SIGTERM/SIGINT
 * - Stale job recovery (handled automatically in claim query)
 *
 * See docs/job-queue-design.md for the overall architecture.
 */

import {
  calculateExceptionRetryDelayMs,
  claimJob as defaultClaimJob,
  claimSingletonJob,
  claimFeedJob,
  finishJob,
  getJobPayload,
  renewJobLease,
  JOB_LEASE_HEARTBEAT_MS,
  SINGLETON_JOB_TYPES,
  type JobType,
} from "./queue";
import {
  handleFetchFeed,
  handleRenewWebsub,
  handleProcessOpmlImport,
  handleMonitorFeedHealth,
  handleCleanup,
  handleResanitizeEntries,
  type JobHandlerResult,
} from "./handlers";
import type { Job } from "../db/schema";
import { logger as appLogger } from "@/lib/logger";
import * as Sentry from "@sentry/nextjs";
import { trackJobProcessed } from "../metrics/metrics";
import { createWorkerCore, type WorkerLogger, type Worker } from "./worker-core";

// Re-export types for backwards compatibility
export type { WorkerLogger, Worker, WorkerStats } from "./worker-core";

/**
 * Default job timeout: 5 minutes.
 * Prevents a hung job (e.g., stuck DB query, pathological XML parsing)
 * from blocking the worker loop forever.
 */
const DEFAULT_JOB_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Worker configuration options.
 */
export interface WorkerConfig {
  /** Polling interval in milliseconds (default: 5000) */
  pollIntervalMs?: number;
  /** Maximum concurrent jobs to process (default: 5) */
  concurrency?: number;
  /** Maximum time a single job can run before being timed out (default: 5 minutes) */
  jobTimeoutMs?: number;
  /** Job types to process (default: all types) */
  jobTypes?: JobType[];
  /** Logger function for worker events */
  logger?: WorkerLogger;
  /**
   * Override for claiming jobs (for testing).
   * @internal
   */
  _claimJob?: (options?: { types?: JobType[] }) => Promise<Job | null>;
  /**
   * Override for processing jobs (for testing).
   * When provided, bypasses the default job handler dispatch.
   * @internal
   */
  _processJob?: (job: Job) => Promise<void>;
}

/**
 * Tracks a job lease that a background heartbeat keeps renewing.
 */
interface JobLeaseController {
  /**
   * Stops the heartbeat and waits for any in-flight renewal to settle, so that
   * {@link JobLeaseController.currentToken} reflects the final committed lease.
   */
  stop: () => Promise<void>;
  /**
   * The lease token (the `running_since` value this worker last wrote), or null
   * once the lease has been lost to another worker.
   */
  currentToken: () => Date | null;
}

/**
 * Starts a heartbeat that periodically renews a running job's lease.
 *
 * The heartbeat is tied to the handler's actual lifetime, deliberately *not* to
 * the worker-core timeout wrapper. If a handler exceeds `jobTimeoutMs` the worker
 * loop abandons the promise and frees the slot, but the underlying work keeps
 * running (we don't forcibly abort fetches/DB writes). Without a lease that work
 * would become reclaimable at the stale threshold and run a second time in
 * another worker (issue #871). By renewing `running_since` until the handler
 * truly settles, the job stays leased for as long as it is actively heartbeating,
 * and is only reclaimed once this worker process dies or freezes.
 *
 * The lease is fenced: each renewal expects the `running_since` it last wrote.
 * If the worker stalls past the stale threshold and another worker reclaims the
 * job, the next renewal finds the token changed, gives up the lease (so it can't
 * steal the job back — no split-brain), and stops the heartbeat.
 *
 * Renewal failures (transient DB hiccups) are logged but never throw and don't
 * drop the lease — at worst they cost one heartbeat of margin.
 */
function startJobLeaseHeartbeat(job: Job, logger: WorkerLogger): JobLeaseController {
  let token: Date | null = job.runningSince;
  // The single in-flight renewal, awaited by stop() so the token is final.
  let pending: Promise<void> = Promise.resolve();
  let renewing = false;

  // A claimed job always has running_since set; guard defensively so we never
  // renew with a null token.
  if (token === null) {
    return { stop: async () => {}, currentToken: () => null };
  }

  const interval = setInterval(() => {
    // Skip if the previous renewal hasn't finished (pathologically slow DB) so
    // `pending` always refers to exactly one renewal.
    if (renewing || token === null) {
      return;
    }
    renewing = true;
    const expected = token;
    pending = renewJobLease(job.id, expected)
      .then((renewed) => {
        if (token === null) {
          return;
        }
        if (renewed) {
          token = renewed;
        } else {
          token = null;
          clearInterval(interval);
          logger.warn("Job lease lost; another worker reclaimed it, stopping heartbeat", {
            jobId: job.id,
            type: job.type,
          });
        }
      })
      .catch((error) => {
        logger.warn("Failed to renew job lease", {
          jobId: job.id,
          type: job.type,
          error: error instanceof Error ? error.message : "Unknown error",
        });
      })
      .finally(() => {
        renewing = false;
      });
  }, JOB_LEASE_HEARTBEAT_MS);

  // Don't let the heartbeat timer keep the process alive during shutdown.
  interval.unref();

  return {
    async stop() {
      clearInterval(interval);
      await pending;
    },
    currentToken: () => token,
  };
}

/**
 * Default structured logger.
 */
const defaultLogger: WorkerLogger = {
  info: (message, meta) => appLogger.info(message, { component: "worker", ...meta }),
  warn: (message, meta) => appLogger.warn(message, { component: "worker", ...meta }),
  error: (message, meta) => appLogger.error(message, { component: "worker", ...meta }),
};

/**
 * Creates a new background worker.
 *
 * @param config - Worker configuration
 * @returns Worker instance
 */
function createWorker(config: WorkerConfig = {}): Worker {
  const {
    pollIntervalMs = 5000,
    concurrency = 5,
    jobTimeoutMs = DEFAULT_JOB_TIMEOUT_MS,
    jobTypes,
    logger = defaultLogger,
    _claimJob: claimJobOverride,
    _processJob: processJobOverride,
  } = config;

  // Use the core worker if we're in test mode (both overrides provided)
  if (processJobOverride) {
    const claimJob = claimJobOverride ?? defaultClaimJob;
    return createWorkerCore({
      pollIntervalMs,
      concurrency,
      jobTimeoutMs,
      jobTypes,
      logger,
      claimJob,
      processJob: processJobOverride,
    });
  }

  // Default claim function - tries different job types in priority order:
  // 1. Regular jobs (process_opml_import) - user-triggered, highest priority
  // 2. Feed jobs (fetch_feed) - data-driven, only for feeds with active subscribers
  // 3. Singleton jobs (renew_websub) - system maintenance
  const baseClaimJob = claimJobOverride ?? defaultClaimJob;

  async function claimJob(options?: { types?: JobType[] }): Promise<Job | null> {
    // First try to claim a regular job (e.g., OPML imports)
    // Exclude feed jobs here since they need special data-driven claiming
    const regularTypes = options?.types?.filter((t) => t !== "fetch_feed");
    if (!options?.types || (regularTypes && regularTypes.length > 0)) {
      const regularJob = await baseClaimJob({
        types: regularTypes || ["process_opml_import"],
      });
      if (regularJob) {
        return regularJob;
      }
    }

    // Try to claim a feed job (data-driven: only if feed has active subscribers)
    if (!options?.types || options.types.includes("fetch_feed")) {
      const feedJob = await claimFeedJob();
      if (feedJob) {
        return feedJob;
      }
    }

    // Try singleton jobs (only if not filtered by type)
    // Singleton jobs self-create if they don't exist
    for (const singletonType of SINGLETON_JOB_TYPES) {
      if (!options?.types || options.types.includes(singletonType)) {
        const singletonJob = await claimSingletonJob(singletonType);
        if (singletonJob) {
          return singletonJob;
        }
      }
    }

    return null;
  }

  /**
   * Processes a single job using the real handlers.
   */
  async function processJob(job: Job): Promise<void> {
    const startTime = Date.now();

    // Keep the job's lease alive for as long as this handler actually runs so a
    // slow (or timed-out-but-still-running) job can't be reclaimed and executed
    // concurrently by another worker (issue #871).
    const lease = startJobLeaseHeartbeat(job, logger);

    // Finishes the job fenced on our lease token. Stops the heartbeat first so
    // the token is final, then writes only if we still hold the lease — if a
    // stalled worker was reclaimed, the write no-ops instead of clobbering the
    // new owner. Returns whether we still owned the job.
    const finishWithLease = async (opts: {
      success: boolean;
      nextRunAt: Date;
      error?: string;
    }): Promise<boolean> => {
      await lease.stop();
      const expectedRunningSince = lease.currentToken();
      if (expectedRunningSince === null) {
        logger.warn("Skipping job finish: lease lost to another worker", {
          jobId: job.id,
          type: job.type,
        });
        return false;
      }
      const finished = await finishJob(job.id, { ...opts, expectedRunningSince });
      if (finished === null) {
        logger.warn("Skipping job finish: lease lost to another worker", {
          jobId: job.id,
          type: job.type,
        });
        return false;
      }
      return true;
    };

    try {
      logger.info(`Processing job ${job.id}`, {
        type: job.type,
        consecutiveFailures: job.consecutiveFailures,
      });

      let result: JobHandlerResult;

      switch (job.type) {
        case "fetch_feed": {
          const payload = getJobPayload<"fetch_feed">(job);
          result = await handleFetchFeed(payload);
          break;
        }
        case "renew_websub": {
          const payload = getJobPayload<"renew_websub">(job);
          result = await handleRenewWebsub(payload);
          break;
        }
        case "monitor_feed_health": {
          const payload = getJobPayload<"monitor_feed_health">(job);
          result = await handleMonitorFeedHealth(payload);
          break;
        }
        case "cleanup": {
          const payload = getJobPayload<"cleanup">(job);
          result = await handleCleanup(payload);
          break;
        }
        case "resanitize_entries": {
          const payload = getJobPayload<"resanitize_entries">(job);
          result = await handleResanitizeEntries(payload);
          break;
        }
        case "process_opml_import": {
          const payload = getJobPayload<"process_opml_import">(job);
          result = await handleProcessOpmlImport(payload);
          break;
        }
        default: {
          // Unknown job type - schedule far in future
          result = {
            success: false,
            nextRunAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
            error: `Unknown job type: ${job.type}`,
          };
        }
      }

      const duration = Date.now() - startTime;

      // Finish the job (update its state for next run)
      await finishWithLease({
        success: result.success,
        nextRunAt: result.nextRunAt,
        error: result.error,
      });

      if (result.success) {
        trackJobProcessed(job.type, "success", duration);

        logger.info(`Job ${job.id} completed`, {
          type: job.type,
          durationMs: duration,
          nextRunAt: result.nextRunAt.toISOString(),
          metadata: result.metadata,
        });
      } else {
        trackJobProcessed(job.type, "failure", duration);

        logger.warn(`Job ${job.id} failed`, {
          type: job.type,
          durationMs: duration,
          error: result.error,
          nextRunAt: result.nextRunAt.toISOString(),
          metadata: result.metadata,
        });
      }
    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : "Unknown error";

      // On exception, schedule the retry with exponential backoff based on how
      // many times this job has failed in a row (finishJob increments the count).
      const nextRunAt = new Date(
        Date.now() + calculateExceptionRetryDelayMs(job.consecutiveFailures)
      );

      try {
        await finishWithLease({
          success: false,
          nextRunAt,
          error: errorMessage,
        });
      } catch (finishError) {
        // If we can't even finish the job, log it
        logger.error("Failed to finish job after exception", {
          jobId: job.id,
          originalError: errorMessage,
          finishError: finishError instanceof Error ? finishError.message : "Unknown",
        });
      }

      trackJobProcessed(job.type, "failure", duration);

      logger.error(`Job ${job.id} threw exception`, {
        type: job.type,
        durationMs: duration,
        error: errorMessage,
      });

      // Report to Sentry with job context
      Sentry.captureException(error, {
        tags: { jobType: job.type },
        extra: {
          jobId: job.id,
          consecutiveFailures: job.consecutiveFailures,
          payload: job.payload,
          durationMs: duration,
        },
      });

      // Re-throw to let the core worker count it as a failure
      throw error;
    } finally {
      // Safety net: ensure the heartbeat is stopped even if finishWithLease was
      // never reached (idempotent with the stop() inside it).
      await lease.stop();
    }
  }

  // Create the worker with the real processJob
  return createWorkerCore({
    pollIntervalMs,
    concurrency,
    jobTimeoutMs,
    jobTypes,
    logger,
    claimJob,
    processJob,
    onJobError: (job, error) => {
      Sentry.captureException(error, {
        tags: { jobType: job.type, context: "executeJob-unhandled" },
        extra: { jobId: job.id },
      });
    },
  });
}

/**
 * Creates and starts a worker with signal handling for graceful shutdown.
 * Useful for running as a standalone process.
 *
 * @param config - Worker configuration
 * @returns The worker instance
 */
export async function startWorkerWithSignalHandling(config: WorkerConfig = {}): Promise<Worker> {
  const logger = config.logger ?? defaultLogger;
  const worker = createWorker(config);

  // Handle graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}, initiating graceful shutdown...`);

    await worker.stop();
    // Flush buffered Sentry events (e.g. failures captured from the jobs that
    // just wound down) before the process exits. No-op if Sentry never
    // initialized.
    await Sentry.close(2000);
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  await worker.start();

  return worker;
}

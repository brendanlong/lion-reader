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

import { claimJob as defaultClaimJob, finishJob, getJobPayload, type JobType } from "./queue";
import {
  handleFetchFeed,
  handleRenewWebsub,
  handleProcessOpmlImport,
  type JobHandlerResult,
} from "./handlers";
import type { Job } from "../db/schema";

/**
 * Function type for claiming a job from the queue.
 */
export type ClaimJobFn = (options?: { types?: JobType[] }) => Promise<Job | null>;

/**
 * Function type for processing a claimed job.
 */
export type ProcessJobFn = (job: Job) => Promise<void>;
import { logger as appLogger } from "@/lib/logger";
import * as Sentry from "@sentry/nextjs";
import { trackJobProcessed } from "../metrics/metrics";

/**
 * Worker configuration options.
 */
export interface WorkerConfig {
  /** Polling interval in milliseconds (default: 5000) */
  pollIntervalMs?: number;
  /** Maximum concurrent jobs to process (default: 5) */
  concurrency?: number;
  /** Job types to process (default: all types) */
  jobTypes?: JobType[];
  /** Logger function for worker events */
  logger?: WorkerLogger;
  /**
   * Override for claiming jobs (for testing).
   * @internal
   */
  _claimJob?: ClaimJobFn;
  /**
   * Override for processing jobs (for testing).
   * When provided, bypasses the default job handler dispatch.
   * @internal
   */
  _processJob?: ProcessJobFn;
}

/**
 * Logger interface for worker events.
 */
export interface WorkerLogger {
  info: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
  error: (message: string, meta?: Record<string, unknown>) => void;
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
 * Worker state.
 */
interface WorkerState {
  /** Whether the worker is running */
  running: boolean;
  /** Whether a shutdown has been requested */
  shuttingDown: boolean;
  /** Currently executing job promises */
  currentlyExecuting: Set<Promise<void>>;
  /** Promise for the main run loop */
  runLoopPromise: Promise<void> | null;
}

/**
 * Sleep for a given number of milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Background job worker.
 *
 * Usage:
 * ```typescript
 * const worker = createWorker({ concurrency: 3 });
 * await worker.start();
 *
 * // Later, to stop gracefully:
 * await worker.stop();
 * ```
 */
export interface Worker {
  /** Start the worker */
  start: () => Promise<void>;
  /** Stop the worker gracefully */
  stop: () => Promise<void>;
  /** Check if the worker is running */
  isRunning: () => boolean;
  /** Get current worker stats */
  getStats: () => WorkerStats;
}

/**
 * Worker statistics.
 */
export interface WorkerStats {
  /** Whether the worker is running */
  running: boolean;
  /** Number of jobs currently being processed */
  activeJobs: number;
  /** Total jobs processed since start */
  totalProcessed: number;
  /** Total jobs that succeeded */
  totalSucceeded: number;
  /** Total jobs that failed */
  totalFailed: number;
}

/**
 * Creates a new background worker.
 *
 * @param config - Worker configuration
 * @returns Worker instance
 */
export function createWorker(config: WorkerConfig = {}): Worker {
  const {
    pollIntervalMs = 5000,
    concurrency = 5,
    jobTypes,
    logger = defaultLogger,
    _claimJob: claimJob = defaultClaimJob,
    _processJob: processJobOverride,
  } = config;

  // Worker state
  const state: WorkerState = {
    running: false,
    shuttingDown: false,
    currentlyExecuting: new Set(),
    runLoopPromise: null,
  };

  // Stats
  let totalProcessed = 0;
  let totalSucceeded = 0;
  let totalFailed = 0;

  /**
   * Processes a single job.
   */
  async function processJob(job: Job): Promise<void> {
    const startTime = Date.now();

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
      await finishJob(job.id, {
        success: result.success,
        nextRunAt: result.nextRunAt,
        error: result.error,
      });

      if (result.success) {
        totalSucceeded++;
        trackJobProcessed(job.type, "success", duration);

        logger.info(`Job ${job.id} completed`, {
          type: job.type,
          durationMs: duration,
          nextRunAt: result.nextRunAt.toISOString(),
          metadata: result.metadata,
        });
      } else {
        totalFailed++;
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

      // On exception, schedule retry with backoff
      const nextRunAt = new Date(Date.now() + 60 * 1000); // 1 minute

      try {
        await finishJob(job.id, {
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

      totalFailed++;
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
    } finally {
      totalProcessed++;
    }
  }

  // Use override if provided, otherwise use default processJob
  const executeJob = processJobOverride ?? processJob;

  /**
   * Main run loop - claims and processes jobs continuously.
   */
  async function runLoop(): Promise<void> {
    while (!state.shuttingDown) {
      // Fill up to capacity
      while (state.currentlyExecuting.size < concurrency && !state.shuttingDown) {
        const job = await claimJob({ types: jobTypes });
        if (job === null) break;

        const promise = executeJob(job).finally(() => {
          state.currentlyExecuting.delete(promise);
        });
        state.currentlyExecuting.add(promise);
      }

      if (state.shuttingDown) break;

      if (state.currentlyExecuting.size >= concurrency) {
        // At capacity — wait for a slot to free up
        await Promise.race(state.currentlyExecuting);
      } else if (state.currentlyExecuting.size > 0) {
        // Have some jobs but queue is empty — wait for either:
        // - A job to complete (might spawn follow-up work)
        // - Poll timeout (new jobs might have arrived)
        await Promise.race([Promise.race(state.currentlyExecuting), sleep(pollIntervalMs)]);
      } else {
        // No jobs at all — poll after delay
        await sleep(pollIntervalMs);
      }
    }

    // Graceful shutdown: wait for in-flight jobs
    if (state.currentlyExecuting.size > 0) {
      logger.info(`Waiting for ${state.currentlyExecuting.size} active jobs to complete...`);
      await Promise.all(state.currentlyExecuting);
    }
  }

  /**
   * Starts the worker.
   */
  async function start(): Promise<void> {
    if (state.running) {
      logger.warn("Worker is already running");
      return;
    }

    state.running = true;
    state.shuttingDown = false;

    logger.info("Worker starting", {
      pollIntervalMs,
      concurrency,
      jobTypes: jobTypes ?? "all",
    });

    // Start the run loop (don't await - runs in background)
    state.runLoopPromise = runLoop();

    logger.info("Worker started");
  }

  /**
   * Stops the worker gracefully.
   */
  async function stop(): Promise<void> {
    if (!state.running) {
      logger.warn("Worker is not running");
      return;
    }

    logger.info("Worker stopping...");

    state.shuttingDown = true;

    // Wait for run loop to complete (it will drain in-flight jobs)
    if (state.runLoopPromise) {
      await state.runLoopPromise;
      state.runLoopPromise = null;
    }

    state.running = false;
    state.shuttingDown = false;

    logger.info("Worker stopped", {
      totalProcessed,
      totalSucceeded,
      totalFailed,
    });
  }

  /**
   * Checks if the worker is running.
   */
  function isRunning(): boolean {
    return state.running;
  }

  /**
   * Gets current worker stats.
   */
  function getStats(): WorkerStats {
    return {
      running: state.running,
      activeJobs: state.currentlyExecuting.size,
      totalProcessed,
      totalSucceeded,
      totalFailed,
    };
  }

  return {
    start,
    stop,
    isRunning,
    getStats,
  };
}

/**
 * Creates and starts a worker with signal handling for graceful shutdown.
 * Useful for running as a standalone process.
 *
 * @param config - Worker configuration
 * @returns The worker instance
 */
export async function startWorkerWithSignalHandling(config: WorkerConfig = {}): Promise<Worker> {
  const worker = createWorker(config);

  // Handle graceful shutdown
  const shutdown = async (signal: string) => {
    const logger = config.logger ?? defaultLogger;
    logger.info(`Received ${signal}, initiating graceful shutdown...`);

    await worker.stop();
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  await worker.start();

  return worker;
}

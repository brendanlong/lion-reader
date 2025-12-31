/**
 * Background worker for processing jobs from the queue.
 *
 * Features:
 * - Polls for due jobs at configurable intervals
 * - Supports concurrent job processing
 * - Graceful shutdown on SIGTERM/SIGINT
 * - Stale job recovery (handled automatically in claim query)
 *
 * See docs/job-queue-design.md for the overall architecture.
 */

import { claimJob, finishJob, getJobPayload, type JobType } from "./queue";
import { handleFetchFeed, handleRenewWebsub, type JobHandlerResult } from "./handlers";
import type { Job } from "../db/schema";
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
  /** Number of jobs currently being processed */
  activeJobs: number;
  /** Polling interval timer */
  pollTimer: ReturnType<typeof setTimeout> | null;
  /** Promise that resolves when shutdown is complete */
  shutdownPromise: Promise<void> | null;
  /** Resolve function for shutdown promise */
  shutdownResolve: (() => void) | null;
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
  const { pollIntervalMs = 5000, concurrency = 5, jobTypes, logger = defaultLogger } = config;

  // Worker state
  const state: WorkerState = {
    running: false,
    shuttingDown: false,
    activeJobs: 0,
    pollTimer: null,
    shutdownPromise: null,
    shutdownResolve: null,
  };

  // Stats
  let totalProcessed = 0;
  let totalSucceeded = 0;
  let totalFailed = 0;

  /**
   * Processes a single job.
   */
  async function processJob(job: Job): Promise<void> {
    state.activeJobs++;
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
      state.activeJobs--;

      // If shutting down and no more active jobs, resolve shutdown promise
      if (state.shuttingDown && state.activeJobs === 0 && state.shutdownResolve) {
        state.shutdownResolve();
      }
    }
  }

  /**
   * Polls for and processes available jobs.
   */
  async function poll(): Promise<void> {
    // Don't poll if shutting down
    if (state.shuttingDown) {
      return;
    }

    // Calculate how many jobs we can claim
    const availableSlots = concurrency - state.activeJobs;

    if (availableSlots <= 0) {
      schedulePoll();
      return;
    }

    // Claim and process jobs up to available slots
    const claimPromises: Promise<void>[] = [];

    for (let i = 0; i < availableSlots; i++) {
      const job = await claimJob({ types: jobTypes });

      if (!job) {
        // No more jobs available
        break;
      }

      // Process job asynchronously (don't await)
      claimPromises.push(processJob(job));
    }

    // Wait for claims to start (not complete)
    if (claimPromises.length > 0) {
      // Process all claimed jobs concurrently
      void Promise.all(claimPromises);
    }

    // Schedule next poll
    schedulePoll();
  }

  /**
   * Schedules the next poll.
   */
  function schedulePoll(): void {
    if (state.shuttingDown || !state.running) {
      return;
    }

    state.pollTimer = setTimeout(() => {
      void poll();
    }, pollIntervalMs);
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

    // Start polling
    void poll();

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

    // Clear poll timer
    if (state.pollTimer) {
      clearTimeout(state.pollTimer);
      state.pollTimer = null;
    }

    // Wait for active jobs to complete
    if (state.activeJobs > 0) {
      logger.info(`Waiting for ${state.activeJobs} active jobs to complete...`);

      state.shutdownPromise = new Promise<void>((resolve) => {
        state.shutdownResolve = resolve;
      });

      await state.shutdownPromise;
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
      activeJobs: state.activeJobs,
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

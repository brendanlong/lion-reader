/**
 * Background worker for processing jobs from the queue.
 *
 * Features:
 * - Polls for due jobs at configurable intervals
 * - Supports concurrent job processing
 * - Graceful shutdown on SIGTERM/SIGINT
 * - Automatic stale job recovery
 */

import {
  claimJob,
  completeJob,
  failJob,
  getJobPayload,
  resetStaleJobs,
  type JobType,
} from "./queue";
import { handleFetchFeed, handleCleanup, type JobHandlerResult } from "./handlers";
import type { Job } from "../db/schema";

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
  /** Stale job timeout in milliseconds (default: 5 minutes) */
  staleJobTimeoutMs?: number;
  /** How often to check for stale jobs in milliseconds (default: 60000) */
  staleJobCheckIntervalMs?: number;
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
 * Default console logger.
 */
const defaultLogger: WorkerLogger = {
  info: (message, meta) => console.log(`[Worker] ${message}`, meta ?? ""),
  warn: (message, meta) => console.warn(`[Worker] ${message}`, meta ?? ""),
  error: (message, meta) => console.error(`[Worker] ${message}`, meta ?? ""),
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
  /** Stale job check timer */
  staleCheckTimer: ReturnType<typeof setInterval> | null;
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
  const {
    pollIntervalMs = 5000,
    concurrency = 5,
    jobTypes,
    staleJobTimeoutMs = 5 * 60 * 1000,
    staleJobCheckIntervalMs = 60 * 1000,
    logger = defaultLogger,
  } = config;

  // Worker state
  const state: WorkerState = {
    running: false,
    shuttingDown: false,
    activeJobs: 0,
    pollTimer: null,
    staleCheckTimer: null,
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
        attempt: job.attempts,
      });

      let result: JobHandlerResult;

      switch (job.type) {
        case "fetch_feed": {
          const payload = getJobPayload<"fetch_feed">(job);
          result = await handleFetchFeed(payload);
          break;
        }
        case "cleanup": {
          const payload = getJobPayload<"cleanup">(job);
          result = await handleCleanup(payload);
          break;
        }
        default: {
          result = {
            success: false,
            error: `Unknown job type: ${job.type}`,
          };
        }
      }

      const duration = Date.now() - startTime;

      if (result.success) {
        await completeJob(job.id);
        totalSucceeded++;
        logger.info(`Job ${job.id} completed`, {
          type: job.type,
          durationMs: duration,
          metadata: result.metadata,
        });
      } else {
        await failJob(job.id, result.error ?? "Unknown error");
        totalFailed++;
        logger.warn(`Job ${job.id} failed`, {
          type: job.type,
          durationMs: duration,
          error: result.error,
          metadata: result.metadata,
        });
      }
    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : "Unknown error";

      await failJob(job.id, errorMessage);
      totalFailed++;

      logger.error(`Job ${job.id} threw exception`, {
        type: job.type,
        durationMs: duration,
        error: errorMessage,
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
   * Checks for and resets stale jobs.
   */
  async function checkStaleJobs(): Promise<void> {
    if (state.shuttingDown) {
      return;
    }

    try {
      const resetCount = await resetStaleJobs(staleJobTimeoutMs);
      if (resetCount > 0) {
        logger.warn(`Reset ${resetCount} stale jobs`);
      }
    } catch (error) {
      logger.error("Failed to check stale jobs", {
        error: error instanceof Error ? error.message : "Unknown error",
      });
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

    // Start stale job check interval
    state.staleCheckTimer = setInterval(() => {
      void checkStaleJobs();
    }, staleJobCheckIntervalMs);

    // Initial stale job check
    await checkStaleJobs();

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

    // Clear timers
    if (state.pollTimer) {
      clearTimeout(state.pollTimer);
      state.pollTimer = null;
    }

    if (state.staleCheckTimer) {
      clearInterval(state.staleCheckTimer);
      state.staleCheckTimer = null;
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

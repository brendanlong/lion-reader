/**
 * Core background worker logic without database dependencies.
 *
 * This module contains the pure worker implementation that can be used
 * for unit testing without requiring database access. The actual job
 * handlers are injected through the config.
 *
 * See docs/job-queue-design.md for the overall architecture.
 */

import type { Job } from "../db/schema";

/**
 * Function type for claiming a job from the queue.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ClaimJobFn = (options?: { types?: any }) => Promise<Job | null>;

/**
 * Function type for processing a claimed job.
 */
export type ProcessJobFn = (job: Job) => Promise<void>;

/**
 * Worker configuration options.
 */
export interface WorkerConfig {
  /** Polling interval in milliseconds (default: 5000) */
  pollIntervalMs?: number;
  /** Maximum concurrent jobs to process (default: 5) */
  concurrency?: number;
  /** Job types to process (default: all types) */
  jobTypes?: string[];
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
 * Internal configuration with required fields.
 */
interface InternalWorkerConfig {
  pollIntervalMs: number;
  concurrency: number;
  jobTypes?: string[];
  logger: WorkerLogger;
  claimJob: ClaimJobFn;
  processJob: ProcessJobFn;
  onJobError?: (job: Job, error: unknown) => void;
}

/**
 * Creates a new background worker with the provided configuration.
 *
 * @param config - Internal worker configuration with all required fields
 * @returns Worker instance
 */
export function createWorkerCore(config: InternalWorkerConfig): Worker {
  const { pollIntervalMs, concurrency, jobTypes, logger, claimJob, processJob, onJobError } =
    config;

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
   * Main run loop - claims and processes jobs continuously.
   */
  async function runLoop(): Promise<void> {
    while (!state.shuttingDown) {
      // Fill up to capacity
      while (state.currentlyExecuting.size < concurrency && !state.shuttingDown) {
        const job = await claimJob({ types: jobTypes });
        if (job === null) break;

        // Wrap processJob with .catch() to ensure no unhandled rejections escape
        // into Promise.race()/Promise.all(). The error is already logged and
        // reported to Sentry inside processJob, so we just need to prevent
        // the rejection from propagating.
        const promise = processJob(job)
          .then(() => {
            totalSucceeded++;
          })
          .catch((error) => {
            totalFailed++;
            // This should rarely happen since processJob has its own try/catch,
            // but handle it defensively
            logger.error("Unexpected error in job execution", {
              jobId: job.id,
              error: error instanceof Error ? error.message : "Unknown error",
            });
            onJobError?.(job, error);
          })
          .finally(() => {
            totalProcessed++;
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

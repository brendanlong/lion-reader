/**
 * Core background worker logic without database dependencies.
 *
 * This module contains the pure worker implementation that can be used
 * for unit testing without requiring database access. The actual job
 * handlers are injected through the config.
 *
 * See src/server/jobs/CLAUDE.md for the overall architecture.
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
  /** Timestamp of last worker loop activity (job completed, polled, or claimed) */
  lastActivityAt: Date;
}

/**
 * Error thrown when a job exceeds its timeout.
 */
class JobTimeoutError extends Error {
  constructor(
    public readonly jobId: string,
    public readonly timeoutMs: number
  ) {
    super(`Job ${jobId} timed out after ${timeoutMs}ms`);
    this.name = "JobTimeoutError";
  }
}

/**
 * Internal configuration with required fields.
 */
interface InternalWorkerConfig {
  pollIntervalMs: number;
  concurrency: number;
  jobTimeoutMs?: number;
  jobTypes?: string[];
  logger: WorkerLogger;
  claimJob: ClaimJobFn;
  processJob: ProcessJobFn;
  /**
   * Called once for every job that fails, whether `processJob` rejected or the
   * job exceeded `jobTimeoutMs`. The loop already logs; this hook is for
   * side-channel reporting (Sentry). It must not throw.
   */
  onJobError?: (job: Job, error: unknown) => void;
  /**
   * Called when a `claimJob` attempt throws (e.g. the DB connection was dropped
   * by a Postgres restart). The loop already logs and retries; this hook is for
   * side-channel reporting (Sentry). It must not throw.
   */
  onClaimError?: (error: unknown) => void;
  /**
   * Called if the main run loop ever rejects. The loop is written not to — claim
   * and process failures are handled inside it — so this firing means an
   * unforeseen bug. The standalone worker uses it to exit the process (so Fly
   * restarts it) rather than lingering as a live process with a dead loop. It
   * must not throw.
   */
  onLoopExit?: (error: unknown) => void;
}

/**
 * Creates a new background worker with the provided configuration.
 *
 * @param config - Internal worker configuration with all required fields
 * @returns Worker instance
 */
export function createWorkerCore(config: InternalWorkerConfig): Worker {
  const {
    pollIntervalMs,
    concurrency,
    jobTimeoutMs,
    jobTypes,
    logger,
    claimJob,
    processJob,
    onJobError,
    onClaimError,
    onLoopExit,
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
  let lastActivityAt = new Date();

  /**
   * Update the last activity timestamp to track worker liveness.
   */
  function touchActivity(): void {
    lastActivityAt = new Date();
  }

  /**
   * Wraps processJob with an optional timeout. If the job doesn't complete
   * within jobTimeoutMs, the promise rejects with a JobTimeoutError.
   * The underlying job may still be running, but the worker loop moves on.
   */
  function processJobWithTimeout(job: Job): Promise<void> {
    if (!jobTimeoutMs) {
      return processJob(job);
    }

    return new Promise<void>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new JobTimeoutError(job.id, jobTimeoutMs));
      }, jobTimeoutMs);

      processJob(job)
        .then(resolve, reject)
        .finally(() => clearTimeout(timeoutId));
    });
  }

  /**
   * Main run loop - claims and processes jobs continuously.
   */
  async function runLoop(): Promise<void> {
    // Whether we've already reported the current run of claim failures. A
    // Postgres restart makes every poll's claim throw for the duration of the
    // outage; reporting each one would flood Sentry. We report the first failure,
    // then stay quiet until a claim succeeds again. Every attempt is still logged.
    // This first report is the *only* Sentry signal for such an outage —
    // `pool.on("error")` treats the underlying drop as routine (see
    // `src/server/db/index.ts`).
    let claimFailureReported = false;

    while (!state.shuttingDown) {
      // Fill up to capacity
      while (state.currentlyExecuting.size < concurrency && !state.shuttingDown) {
        let job: Job | null;
        try {
          job = await claimJob({ types: jobTypes });
        } catch (error) {
          // A failure while claiming — most importantly a DB connection dropped
          // by a Postgres restart ("Connection terminated unexpectedly") — must
          // NOT kill the loop. Without this guard the rejection escaped runLoop;
          // because Sentry's onUnhandledRejection integration runs in 'warn'
          // mode the process kept running with a dead loop until it was manually
          // restarted (the app server, handling each request independently,
          // self-heals for free). Log it, stop filling this cycle, and fall
          // through to the sleep below so the next cycle retries on a fresh
          // pooled connection. (The outer loop's trailing touchActivity keeps
          // the liveness check fresh — the loop itself is healthy; it's the DB
          // that's unreachable, and a restart wouldn't fix that.)
          logger.error("Failed to claim job; retrying after poll interval", {
            error: error instanceof Error ? error.message : "Unknown error",
          });
          if (!claimFailureReported) {
            claimFailureReported = true;
            onClaimError?.(error);
          }
          break;
        }
        // The claim succeeded (a job or an empty queue) — the DB is reachable
        // again, so re-arm reporting for any future outage.
        if (claimFailureReported) {
          claimFailureReported = false;
          logger.info("Job claiming recovered after earlier failures");
        }
        touchActivity();
        if (job === null) break;

        // Wrap processJob with .catch() to ensure no unhandled rejections escape
        // into Promise.race()/Promise.all(), and to count the failure. This
        // catch is also where a failed job is reported (via onJobError) — the
        // one place that sees both a handler exception and a timeout.
        const promise = processJobWithTimeout(job)
          .then(() => {
            totalSucceeded++;
          })
          .catch((error) => {
            totalFailed++;
            if (error instanceof JobTimeoutError) {
              logger.error("Job timed out", {
                jobId: job.id,
                type: job.type,
                timeoutMs: jobTimeoutMs,
              });
            } else {
              // The injected processJob rejected. The production one already
              // logged the details before re-throwing; this is the loop-level
              // record, and the only one for an injected processJob.
              logger.error("Unexpected error in job execution", {
                jobId: job.id,
                error: error instanceof Error ? error.message : "Unknown error",
              });
            }
            onJobError?.(job, error);
          })
          .finally(() => {
            totalProcessed++;
            touchActivity();
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

      touchActivity();
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

    // Start the run loop (don't await - runs in background). Attach a catch so a
    // loop that rejects can never become an unhandled rejection: with claim and
    // process failures already handled inside runLoop this should never fire, but
    // if it does we surface it loudly and hand off to onLoopExit (the standalone
    // worker exits so Fly restarts it) instead of silently leaving a live process
    // with a dead loop.
    state.runLoopPromise = runLoop().catch((error) => {
      state.running = false;
      logger.error("Worker run loop terminated unexpectedly", {
        error: error instanceof Error ? error.message : "Unknown error",
      });
      onLoopExit?.(error);
    });

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
      lastActivityAt,
    };
  }

  return {
    start,
    stop,
    isRunning,
    getStats,
  };
}

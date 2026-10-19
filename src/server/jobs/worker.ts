/**
 * Background worker for processing jobs from the queue.
 *
 * Features:
 * - Event-driven job processing with Promise.race for efficient slot management
 * - Immediately fills slots when jobs complete (no polling delay)
 * - Falls back to polling when queue is empty
 * - Supports concurrent job processing up to configurable limit
 * - Stale job recovery (handled automatically in claim query)
 *
 * See src/server/jobs/CLAUDE.md for the overall architecture.
 */

import {
  calculateExceptionRetryDelayMs,
  claimJob as claimRegularJob,
  claimSingletonJob,
  claimFeedJob,
  claimFullContentJob,
  DEFAULT_JOB_TIMEOUT_MS,
  finishJob,
  getJobIntervalMs,
  getJobPayload,
  isFixedIntervalJobType,
  isJobType,
  seedSingletonJobs,
  GENERIC_CLAIM_JOB_TYPES,
  SINGLETON_JOB_TYPES,
  type FinishJobOptions,
  type FixedIntervalJobType,
  type JobPayloads,
  type JobType,
} from "./queue";
import { handleFetchFeed } from "./handlers/fetch-feed";
import { handleRenewWebsub } from "./handlers/renew-websub";
import { handleProcessOpmlImport } from "./handlers/process-opml-import";
import { handleFetchFullContent } from "./handlers/fetch-full-content";
import { handleMonitorFeedHealth } from "./handlers/monitor-feed-health";
import { handleCleanup } from "./handlers/cleanup";
import { handleReconcileCounters } from "./handlers/reconcile-counters";
import { handleBackfillGettingStarted } from "./handlers/backfill-getting-started";
import type { JobHandlerResult, JobMetadata, OneTimeJobHandlerResult } from "./handlers/types";
import type { Job } from "../db/schema";
import { logger as appLogger } from "@/lib/logger";
import * as Sentry from "@sentry/nextjs";
import { trackJobProcessed } from "../metrics/metrics";
import { getMaintenance } from "../services/site-status";
import { createWorkerCore, type WorkerLogger, type Worker } from "./worker-core";

export type { WorkerLogger, Worker } from "./worker-core";

/**
 * How often the claim loop checks singleton jobs *before* feed jobs. Feed jobs
 * normally win the race for throughput, but a large `fetch_feed` backlog (after
 * downtime or an OPML import) would otherwise starve the singleton maintenance
 * jobs (`SINGLETON_JOB_TYPES` in queue.ts — renew_websub, monitor_feed_health,
 * cleanup) forever. Every Nth claim we look at
 * singletons first so an overdue one is picked up within a handful of rapid
 * claim cycles regardless of backlog depth.
 */
export const SINGLETON_PRIORITY_INTERVAL = 4;

export const DEFAULT_POLL_INTERVAL_MS = 5000;

/** Production sets `WORKER_CONCURRENCY` in fly.toml; this is the local default. */
export const DEFAULT_CONCURRENCY = 3;

/**
 * Worker configuration options.
 */
export interface WorkerConfig {
  /** Polling interval in milliseconds (default: {@link DEFAULT_POLL_INTERVAL_MS}) */
  pollIntervalMs?: number;
  /** Maximum concurrent jobs to process (default: {@link DEFAULT_CONCURRENCY}) */
  concurrency?: number;
  /** Maximum time a single job can run before being timed out (default: {@link DEFAULT_JOB_TIMEOUT_MS}) */
  jobTimeoutMs?: number;
  /** Logger function for worker events */
  logger?: WorkerLogger;
  /**
   * Called if the main run loop ever exits unexpectedly (see
   * {@link InternalWorkerConfig.onLoopExit} in worker-core). The standalone
   * process wires this to a process exit so Fly restarts the machine rather than
   * leaving a live process with a dead loop.
   */
  onLoopExit?: (error: unknown) => void;
}

/**
 * The claim primitives the worker's claim strategy composes. Injected so the
 * round-robin ordering below is unit-testable without touching the database
 * (production passes the real queue functions).
 */
export interface WorkerClaimDeps {
  /** Due-job claim for regular (non-feed, non-singleton, non-full-content) jobs. */
  claimRegular: () => Promise<Job | null>;
  /** Data-driven fetch_feed claim (only feeds with active subscribers). */
  claimFeed: () => Promise<Job | null>;
  /** Due-gated singleton claim. */
  claimSingleton: (type: JobType) => Promise<Job | null>;
  /** Concurrency-capped fetch_full_content claim (see `claimFullContentJob`). */
  claimFullContent: () => Promise<Job | null>;
}

/**
 * The cycle, within each SINGLETON_PRIORITY_INTERVAL, on which
 * `fetch_full_content` jobs are checked first. Cycle 0 is the singletons'.
 */
export const FULL_CONTENT_PRIORITY_CYCLE = 2;

/**
 * Builds the worker's claim function. Priority order:
 *
 * 1. Regular jobs (`process_opml_import`) — user-triggered, always first.
 * 2. Feed, singleton and `fetch_full_content` jobs — round-robined. On most
 *    cycles feeds go first (throughput). Every SINGLETON_PRIORITY_INTERVAL-th
 *    cycle singletons go first, so an overdue maintenance job is claimed within
 *    a few cycles even under a deep fetch_feed backlog; and one other cycle per
 *    interval (FULL_CONTENT_PRIORITY_CYCLE) puts full-content jobs first, so
 *    pushed entries get their turn under a feed backlog too. Whichever category
 *    goes first, the others are still tried if it has nothing to claim — none
 *    is ever skipped on a given cycle, and a full-content job still runs
 *    whenever nothing else is due.
 *
 * Full-content jobs are created by third-party hub pushes and can each hold a
 * slot for minutes, so they deliberately don't get priority over feed polls:
 * on a single-slot worker (production runs one), that would let a steady push
 * stream starve polls and maintenance outright. What the rotation guarantees is
 * a bounded share of *claims* — under a backlog in every category, one in
 * SINGLETON_PRIORITY_INTERVAL — so a feed poll or an overdue singleton waits at
 * most a few claims, one of which may be a long full-content job. It doesn't
 * bound their share of wall-clock time. `claimFullContentJob`'s running cap
 * adds a slot bound on multi-slot workers.
 *
 * Exported for unit tests (which inject fake claim deps to verify the
 * ordering); production calls it only from `createWorker` below.
 */
export function createWorkerClaimJob(deps: WorkerClaimDeps): () => Promise<Job | null> {
  // Try singleton jobs. claimSingleton only returns a due job, so checking these
  // ahead of feeds costs a few indexed no-op lookups when nothing is due.
  async function tryClaimSingletonJob(): Promise<Job | null> {
    for (const singletonType of SINGLETON_JOB_TYPES) {
      const singletonJob = await deps.claimSingleton(singletonType);
      if (singletonJob) {
        return singletonJob;
      }
    }
    return null;
  }

  async function firstClaimed(claims: Array<() => Promise<Job | null>>): Promise<Job | null> {
    for (const claim of claims) {
      const job = await claim();
      if (job) {
        return job;
      }
    }
    return null;
  }

  // Round-robin counter deciding which category is checked first.
  let claimCounter = 0;

  return async function claimJob(): Promise<Job | null> {
    // First try to claim a regular job (OPML imports). Feed and full-content
    // jobs have their own claims in the rotation below.
    const regularJob = await deps.claimRegular();
    if (regularJob) {
      return regularJob;
    }

    const cycle = claimCounter++ % SINGLETON_PRIORITY_INTERVAL;

    if (cycle === 0) {
      return firstClaimed([tryClaimSingletonJob, deps.claimFeed, deps.claimFullContent]);
    }
    if (cycle === FULL_CONTENT_PRIORITY_CYCLE) {
      return firstClaimed([deps.claimFullContent, deps.claimFeed, tryClaimSingletonJob]);
    }
    return firstClaimed([deps.claimFeed, tryClaimSingletonJob, deps.claimFullContent]);
  };
}

const UNKNOWN_JOB_TYPE_RETRY_MS = 7 * 24 * 60 * 60 * 1000;

type WorkerJobResult = Omit<JobHandlerResult, "nextRunAt"> &
  Pick<FinishJobOptions, "nextRunAt" | "consumeForceReprocess">;

function finishOneTime(result: OneTimeJobHandlerResult): WorkerJobResult {
  return { ...result, nextRunAt: null };
}

type SelfSchedulingJobType = Exclude<JobType, FixedIntervalJobType>;

/**
 * Runs each job type. Together with {@link FIXED_INTERVAL_JOB_HANDLERS},
 * exhaustive, so a new `JobType` without a handler doesn't compile.
 */
const JOB_HANDLERS: {
  [K in SelfSchedulingJobType]: (payload: JobPayloads[K], job: Job) => Promise<WorkerJobResult>;
} = {
  fetch_feed: async (payload) => {
    // The one-shot forceReprocess token observed at claim (null for an
    // ordinary poll). On a successful run finishJob consumes it with optimistic
    // concurrency, or re-runs now if a subscribe re-armed the job mid-run.
    const claimedAt = payload.forceReprocessRequestedAt ?? null;
    const result = await handleFetchFeed(payload, { forceReprocess: claimedAt !== null });
    return { ...result, consumeForceReprocess: { claimedAt } };
  },
  backfill_getting_started: handleBackfillGettingStarted,
  process_opml_import: async (payload) => finishOneTime(await handleProcessOpmlImport(payload)),
  fetch_full_content: async (payload, job) =>
    finishOneTime(await handleFetchFullContent(payload, job.consecutiveFailures)),
};

/** Handlers of the jobs the worker schedules (`intervalMs` in queue.ts). */
const FIXED_INTERVAL_JOB_HANDLERS: { [K in FixedIntervalJobType]: () => Promise<JobMetadata> } = {
  renew_websub: handleRenewWebsub,
  monitor_feed_health: handleMonitorFeedHealth,
  cleanup: handleCleanup,
  reconcile_membership_counters: handleReconcileCounters,
};

/**
 * Runs `job`'s handler and resolves when to run it next.
 *
 * @testonly
 */
export async function runJobHandler(
  job: Job,
  type: JobType,
  startedAt: number
): Promise<WorkerJobResult> {
  if (isFixedIntervalJobType(type)) {
    const metadata = await FIXED_INTERVAL_JOB_HANDLERS[type]();
    return { success: true, nextRunAt: new Date(startedAt + getJobIntervalMs(type)), metadata };
  }
  return runSelfSchedulingHandler(job, type);
}

function runSelfSchedulingHandler<K extends SelfSchedulingJobType>(
  job: Job,
  type: K
): Promise<WorkerJobResult> {
  return JOB_HANDLERS[type](getJobPayload(job, type), job);
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
export function createWorker(config: WorkerConfig = {}): Worker {
  const {
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    concurrency = DEFAULT_CONCURRENCY,
    jobTimeoutMs = DEFAULT_JOB_TIMEOUT_MS,
    logger = defaultLogger,
    onLoopExit,
  } = config;

  // Default claim function - tries different job types in priority order:
  // 1. Regular jobs (process_opml_import) - user-triggered, highest priority
  // 2. Feed jobs (fetch_feed), singleton jobs (renew_websub, etc.) and
  //    fetch_full_content jobs - round-robined so none can starve the others
  //    (see createWorkerClaimJob).
  const claimJob = createWorkerClaimJob({
    claimRegular: () => claimRegularJob({ types: GENERIC_CLAIM_JOB_TYPES }),
    claimFeed: claimFeedJob,
    claimSingleton: claimSingletonJob,
    claimFullContent: claimFullContentJob,
  });

  // Maintenance-mode guard: while maintenance is on, claim nothing so the worker
  // never touches Postgres (maintenance is used during DB migrations). Returning
  // null makes the core loop simply sleep(pollIntervalMs) and poll again; the
  // process stays alive and resumes automatically when the flag clears. The
  // maintenance read is cached in-process, so this adds no per-claim Redis load.
  let maintenancePaused = false;
  // Seeded before the first claim rather than at start, so it waits out
  // maintenance too; a failure surfaces as a claim error and is retried.
  let singletonsSeeded = false;
  const guardedClaimJob = async (): Promise<Job | null> => {
    const { enabled } = await getMaintenance();
    if (enabled) {
      if (!maintenancePaused) {
        maintenancePaused = true;
        logger.warn("Maintenance mode active — worker paused, not claiming jobs");
      }
      return null;
    }
    if (maintenancePaused) {
      maintenancePaused = false;
      logger.info("Maintenance mode cleared — worker resumed");
    }
    if (!singletonsSeeded) {
      await seedSingletonJobs();
      singletonsSeeded = true;
    }
    return claimJob();
  };

  /**
   * Processes a single job using the real handlers.
   */
  async function processJob(job: Job): Promise<void> {
    const startTime = Date.now();

    try {
      logger.info(`Processing job ${job.id}`, {
        type: job.type,
        consecutiveFailures: job.consecutiveFailures,
      });

      const result: WorkerJobResult = isJobType(job.type)
        ? await runJobHandler(job, job.type, startTime)
        : {
            // Possibly enqueued by a newer release during a rolling deploy:
            // leave it for a worker that knows the type.
            success: false,
            nextRunAt: new Date(Date.now() + UNKNOWN_JOB_TYPE_RETRY_MS),
            error: `Unknown job type: ${job.type}`,
          };

      const duration = Date.now() - startTime;

      await finishJob(job.id, {
        success: result.success,
        nextRunAt: result.nextRunAt,
        error: result.error,
        consumeForceReprocess: result.consumeForceReprocess,
      });

      if (result.success) {
        trackJobProcessed(job.type, "success", duration);

        logger.info(`Job ${job.id} completed`, {
          type: job.type,
          durationMs: duration,
          nextRunAt: result.nextRunAt?.toISOString(),
          metadata: result.metadata,
        });
      } else {
        trackJobProcessed(job.type, "failure", duration);

        logger.warn(`Job ${job.id} failed`, {
          type: job.type,
          durationMs: duration,
          error: result.error,
          nextRunAt: result.nextRunAt?.toISOString(),
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

      trackJobProcessed(job.type, "failure", duration);

      logger.error(`Job ${job.id} threw exception`, {
        type: job.type,
        durationMs: duration,
        error: errorMessage,
      });

      // Re-throw so the core worker counts it as a failure and reports it via
      // onJobError (the single Sentry reporter for job failures — see below).
      throw error;
    }
  }

  // Create the worker with the real processJob
  return createWorkerCore({
    pollIntervalMs,
    concurrency,
    jobTimeoutMs,
    logger,
    claimJob: guardedClaimJob,
    processJob,
    // The single Sentry reporter for a failed job. It covers both ways a job
    // can fail: `processJob` finishes the job with backoff, logs, and re-throws
    // (so the loop counts the failure), and the loop's own timeout wrapper
    // rejects with a JobTimeoutError that never reaches `processJob`'s catch.
    onJobError: (job, error) => {
      Sentry.captureException(error, {
        tags: { jobType: job.type, context: "job-execution" },
        extra: {
          jobId: job.id,
          consecutiveFailures: job.consecutiveFailures,
          payload: job.payload,
        },
      });
    },
    onClaimError: (error) => {
      // Claiming failed (typically a DB connection dropped by a Postgres
      // restart). The loop logs and retries; report it so a persistent claim
      // outage is visible in Sentry, not just the logs.
      Sentry.captureException(error, {
        tags: { context: "worker-claim" },
      });
    },
    onLoopExit: (error) => {
      Sentry.captureException(error, {
        tags: { context: "worker-loop-exit" },
      });
      onLoopExit?.(error);
    },
  });
}

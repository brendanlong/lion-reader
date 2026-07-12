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
 * How often the claim loop checks singleton jobs *before* feed jobs. Feed jobs
 * normally win the race for throughput, but a large `fetch_feed` backlog (after
 * downtime or an OPML import) would otherwise starve the singleton maintenance
 * jobs (`SINGLETON_JOB_TYPES` in queue.ts — renew_websub, monitor_feed_health,
 * cleanup) forever. Every Nth claim we look at
 * singletons first so an overdue one is picked up within a handful of rapid
 * claim cycles regardless of backlog depth.
 */
export const SINGLETON_PRIORITY_INTERVAL = 4;

/**
 * Hard cap on how long a single handler's lease is heartbeated, as a multiple of
 * `jobTimeoutMs`. The worker-loop timeout frees the slot at `jobTimeoutMs` but
 * intentionally does not abort the handler (issue #871), and the heartbeat keeps
 * the lease alive so the still-running work isn't double-executed. A handler
 * stuck on a never-settling await would otherwise hold its lease until the
 * process restarts. Past this cap we stop heartbeating and alert, so the job
 * becomes reclaimable at the stale threshold — bounding the "wedged forever"
 * case while giving legitimately-slow handlers enormous margin over the timeout.
 */
const LEASE_HARD_CAP_MULTIPLIER = 6;

/**
 * Floor on the lease hard cap. The cap is only checked on heartbeat ticks, so a
 * cap below one heartbeat interval would trip on the FIRST tick — no renewal
 * would ever happen, the job would go reclaimable at the stale threshold while
 * its handler is legitimately running, and the anti-double-execution lease
 * (issue #871) would be silently disabled. A misconfigured tiny `jobTimeoutMs`
 * must not be able to do that, so the cap never drops below a few heartbeats.
 */
const LEASE_HARD_CAP_MIN_MS = 3 * JOB_LEASE_HEARTBEAT_MS;

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
export interface JobLeaseController {
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
 *
 * Exported for integration tests (which inject a small `heartbeatMs` to exercise
 * the hard cap against a real database); production code calls it only from
 * `processJob` below.
 */
export function startJobLeaseHeartbeat(
  job: Job,
  logger: WorkerLogger,
  maxLeaseDurationMs: number,
  // Injectable for tests only — production always uses the shared constant.
  heartbeatMs: number = JOB_LEASE_HEARTBEAT_MS
): JobLeaseController {
  let token: Date | null = job.runningSince;
  // The single in-flight renewal, awaited by stop() so the token is final.
  let pending: Promise<void> = Promise.resolve();
  let renewing = false;
  const startTime = Date.now();
  let hardCapped = false;

  // A claimed job always has running_since set; guard defensively so we never
  // renew with a null token.
  if (token === null) {
    return { stop: async () => {}, currentToken: () => null };
  }

  const interval = setInterval(() => {
    // Hard cap: a handler that has heartbeated far past its timeout is wedged on
    // a never-settling await. Stop renewing (and alert) so the job can be
    // reclaimed by another worker at the stale threshold instead of being pinned
    // until this process restarts. We leave `token` intact rather than nulling
    // it: if the handler does eventually settle before another worker reclaims,
    // finishJob is still fenced on this token and either commits legitimately or
    // no-ops against the new owner.
    if (!hardCapped && Date.now() - startTime > maxLeaseDurationMs) {
      hardCapped = true;
      clearInterval(interval);
      logger.error("Job lease hard cap reached; handler appears wedged, stopping heartbeat", {
        jobId: job.id,
        type: job.type,
        maxLeaseDurationMs,
      });
      Sentry.captureMessage("Job handler exceeded lease hard cap (wedged)", {
        level: "error",
        tags: { jobType: job.type },
        extra: { jobId: job.id, maxLeaseDurationMs },
      });
      return;
    }

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
  }, heartbeatMs);

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
 * The claim primitives the worker's claim strategy composes. Injected so the
 * round-robin ordering below is unit-testable without touching the database
 * (production passes the real queue functions).
 */
export interface WorkerClaimDeps {
  /** Generic due-job claim, used for regular (non-feed, non-singleton) jobs. */
  claimRegular: (options: { types: JobType[] }) => Promise<Job | null>;
  /** Data-driven fetch_feed claim (only feeds with active subscribers). */
  claimFeed: () => Promise<Job | null>;
  /** Due-gated singleton claim (self-creates the row on first ever run). */
  claimSingleton: (type: JobType) => Promise<Job | null>;
}

/**
 * Builds the worker's claim function. Priority order:
 *
 * 1. Regular jobs (process_opml_import) — user-triggered, always first.
 * 2. Feed jobs vs. singleton jobs — round-robined: on most cycles feeds go
 *    first (throughput), but every SINGLETON_PRIORITY_INTERVAL-th cycle
 *    singletons are checked first, so an overdue maintenance job is claimed
 *    within a few cycles even under a deep fetch_feed backlog (which would
 *    otherwise starve singletons forever). Whichever category is checked
 *    first, the other is still tried if it has nothing to claim — neither is
 *    ever skipped on a given cycle.
 *
 * Exported for unit tests (which inject fake claim deps to verify the
 * ordering); production calls it only from `createWorker` below.
 */
export function createWorkerClaimJob(
  deps: WorkerClaimDeps
): (options?: { types?: JobType[] }) => Promise<Job | null> {
  // Try to claim a feed job (data-driven: only if a feed has active subscribers).
  async function tryClaimFeedJob(options?: { types?: JobType[] }): Promise<Job | null> {
    if (!options?.types || options.types.includes("fetch_feed")) {
      return deps.claimFeed();
    }
    return null;
  }

  // Try singleton jobs. claimSingleton only returns a due job, so checking these
  // ahead of feeds costs a few indexed no-op lookups when nothing is due.
  async function tryClaimSingletonJob(options?: { types?: JobType[] }): Promise<Job | null> {
    for (const singletonType of SINGLETON_JOB_TYPES) {
      if (!options?.types || options.types.includes(singletonType)) {
        const singletonJob = await deps.claimSingleton(singletonType);
        if (singletonJob) {
          return singletonJob;
        }
      }
    }
    return null;
  }

  // Round-robin counter deciding whether singletons or feeds are checked first.
  let claimCounter = 0;

  return async function claimJob(options?: { types?: JobType[] }): Promise<Job | null> {
    // First try to claim a regular job (e.g., OPML imports)
    // Exclude feed jobs here since they need special data-driven claiming
    const regularTypes = options?.types?.filter((t) => t !== "fetch_feed");
    if (!options?.types || (regularTypes && regularTypes.length > 0)) {
      const regularJob = await deps.claimRegular({
        types: regularTypes || ["process_opml_import"],
      });
      if (regularJob) {
        return regularJob;
      }
    }

    const singletonsFirst = claimCounter++ % SINGLETON_PRIORITY_INTERVAL === 0;

    if (singletonsFirst) {
      return (await tryClaimSingletonJob(options)) ?? (await tryClaimFeedJob(options));
    }
    return (await tryClaimFeedJob(options)) ?? (await tryClaimSingletonJob(options));
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
  // 2. Feed jobs (fetch_feed) and singleton jobs (renew_websub, etc.) - the
  //    order between these two is round-robined so a fetch_feed backlog can't
  //    starve singleton maintenance (see SINGLETON_PRIORITY_INTERVAL).
  const baseClaimJob = claimJobOverride ?? defaultClaimJob;

  const claimJob = createWorkerClaimJob({
    claimRegular: baseClaimJob,
    claimFeed: claimFeedJob,
    claimSingleton: claimSingletonJob,
  });

  /**
   * Processes a single job using the real handlers.
   */
  async function processJob(job: Job): Promise<void> {
    const startTime = Date.now();

    // Keep the job's lease alive for as long as this handler actually runs so a
    // slow (or timed-out-but-still-running) job can't be reclaimed and executed
    // concurrently by another worker (issue #871), up to a hard cap that bounds a
    // permanently-wedged handler.
    const lease = startJobLeaseHeartbeat(
      job,
      logger,
      Math.max(jobTimeoutMs * LEASE_HARD_CAP_MULTIPLIER, LEASE_HARD_CAP_MIN_MS)
    );

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

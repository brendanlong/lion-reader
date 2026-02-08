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
  claimJob as defaultClaimJob,
  claimSingletonJob,
  claimFeedJob,
  claimScoreTrainingJob,
  finishJob,
  getJobPayload,
  type JobType,
} from "./queue";
import {
  handleFetchFeed,
  handleRenewWebsub,
  handleProcessOpmlImport,
  handleTrainScoreModel,
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
  _claimJob?: (options?: { types?: JobType[] }) => Promise<Job | null>;
  /**
   * Override for processing jobs (for testing).
   * When provided, bypasses the default job handler dispatch.
   * @internal
   */
  _processJob?: (job: Job) => Promise<void>;
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
  // 4. Score training jobs - data-driven, for users with enough training data
  const baseClaimJob = claimJobOverride ?? defaultClaimJob;

  async function claimJob(options?: { types?: JobType[] }): Promise<Job | null> {
    // First try to claim a regular job (e.g., OPML imports)
    // Exclude feed jobs here since they need special data-driven claiming
    const regularTypes = options?.types?.filter(
      (t) => t !== "fetch_feed" && t !== "train_score_model"
    );
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
    if (!options?.types || options.types.includes("renew_websub")) {
      const singletonJob = await claimSingletonJob("renew_websub");
      if (singletonJob) {
        return singletonJob;
      }
    }

    // Try to claim a score training job (data-driven: only if user needs training)
    if (!options?.types || options.types.includes("train_score_model")) {
      const trainingJob = await claimScoreTrainingJob();
      if (trainingJob) {
        return trainingJob;
      }
    }

    return null;
  }

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
        case "train_score_model": {
          const payload = getJobPayload<"train_score_model">(job);
          result = await handleTrainScoreModel(payload);
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
    }
  }

  // Create the worker with the real processJob
  return createWorkerCore({
    pollIntervalMs,
    concurrency,
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
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  await worker.start();

  return worker;
}

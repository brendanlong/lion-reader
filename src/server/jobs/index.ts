/**
 * Job queue module exports.
 *
 * See docs/job-queue-design.md for the overall architecture.
 */

export {
  // Core queue functions
  createJob,
  claimJob,
  finishJob,
  getJob,
  getJobPayload,
  listJobs,

  // Feed job functions
  getFeedJob,
  createOrEnableFeedJob,
  enableFeedJob,
  syncFeedJobEnabled,
  updateFeedJobNextRun,

  // System job functions
  ensureRenewWebsubJobExists,

  // Types
  type JobPayloads,
  type JobType,
  type CreateJobOptions,
  type ClaimJobOptions,
  type FinishJobOptions,
} from "./queue";

export {
  // Job handlers
  handleFetchFeed,
  handleRenewWebsub,

  // Types
  type JobHandlerResult,
} from "./handlers";

export {
  // Worker
  createWorker,
  startWorkerWithSignalHandling,

  // Types
  type Worker,
  type WorkerConfig,
  type WorkerLogger,
  type WorkerStats,
} from "./worker";

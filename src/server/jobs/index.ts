/**
 * Job queue module exports.
 */

export {
  // Core queue functions
  createJob,
  claimJob,
  completeJob,
  failJob,
  getJob,
  getJobPayload,
  listJobs,

  // Maintenance functions
  deleteCompletedJobs,
  resetStaleJobs,

  // Utility functions
  calculateBackoff,

  // Types
  type JobPayloads,
  type JobType,
  type CreateJobOptions,
  type ClaimJobOptions,
} from "./queue";

export {
  // Job handlers
  handleFetchFeed,
  handleCleanup,
  createInitialFetchJob,

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

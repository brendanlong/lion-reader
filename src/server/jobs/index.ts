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

  // Feed job functions (data-driven)
  ensureFeedJob,
  createOrEnableFeedJob, // Deprecated alias for ensureFeedJob
  updateFeedJobNextRun,
  claimFeedJob,

  // Score training job functions (data-driven)
  ensureScoreTrainingJob,
  claimScoreTrainingJob,

  // Singleton job functions
  claimSingletonJob,

  // Types
  type JobPayloads,
  type JobType,
} from "./queue";

export type {} from "./handlers";

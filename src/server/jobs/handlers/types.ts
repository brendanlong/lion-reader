/**
 * Shared shapes returned by job handlers.
 *
 * See src/server/jobs/CLAUDE.md for the overall architecture.
 */

/** What a run reports, for the worker's completion log line. */
export type JobMetadata = Record<string, unknown>;

/**
 * Result of a job handler execution. A fixed-interval job's handler (one with
 * `intervalMs` in queue.ts) returns only its {@link JobMetadata} instead.
 */
export interface JobHandlerResult {
  /** Whether the job completed successfully */
  success: boolean;
  /** When the job should next run */
  nextRunAt: Date;
  /** Error message if the job failed */
  error?: string;
  /** Any additional metadata about the job execution */
  metadata?: JobMetadata;
}

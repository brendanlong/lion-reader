/**
 * Shared shape returned by every job handler.
 *
 * See docs/job-queue-design.md for the overall architecture.
 */

/**
 * Result of a job handler execution.
 */
export interface JobHandlerResult {
  /** Whether the job completed successfully */
  success: boolean;
  /** When the job should next run */
  nextRunAt: Date;
  /** Error message if the job failed */
  error?: string;
  /** Any additional metadata about the job execution */
  metadata?: Record<string, unknown>;
}

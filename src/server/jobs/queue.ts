/**
 * Postgres-based job queue implementation.
 *
 * Uses row locking (SELECT FOR UPDATE SKIP LOCKED) for concurrent job claiming,
 * ensuring only one worker can process a job at a time.
 */

import { and, eq, lte, sql, desc } from "drizzle-orm";
import { db } from "../db";
import { jobs, type Job } from "../db/schema";
import { generateUuidv7 } from "../../lib/uuidv7";

/**
 * Raw job row returned from SQL queries (dates are strings).
 */
type RawJobRow = {
  id: string;
  type: string;
  payload: string;
  scheduled_for: string;
  started_at: string | null;
  completed_at: string | null;
  status: "pending" | "running" | "completed" | "failed";
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  created_at: string;
} & Record<string, unknown>;

/**
 * Converts a raw SQL row to a Job with proper Date objects.
 */
function rowToJob(row: RawJobRow): Job {
  return {
    id: row.id,
    type: row.type,
    payload: row.payload,
    scheduledFor: new Date(row.scheduled_for),
    startedAt: row.started_at ? new Date(row.started_at) : null,
    completedAt: row.completed_at ? new Date(row.completed_at) : null,
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    lastError: row.last_error,
    createdAt: new Date(row.created_at),
  };
}

/**
 * Job payload types for different job types.
 * Add new job types here as needed.
 */
export interface JobPayloads {
  fetch_feed: { feedId: string };
  cleanup: { olderThanDays?: number };
  renew_websub: Record<string, never>; // Empty payload - renews all expiring subscriptions
}

export type JobType = keyof JobPayloads;

/**
 * Options for creating a new job.
 */
export interface CreateJobOptions<T extends JobType> {
  type: T;
  payload: JobPayloads[T];
  scheduledFor?: Date;
  maxAttempts?: number;
}

/**
 * Options for claiming a job.
 */
export interface ClaimJobOptions {
  types?: JobType[];
}

/**
 * Base backoff duration in milliseconds (1 minute).
 */
const BASE_BACKOFF_MS = 60 * 1000;

/**
 * Maximum backoff duration in milliseconds (about 4 hours - 2^8 minutes).
 */
const MAX_BACKOFF_MS = 256 * 60 * 1000;

/**
 * Calculates the backoff delay for a given attempt number.
 * Uses exponential backoff: 1 minute * 2^(attempt-1)
 * Caps at MAX_BACKOFF_MS.
 *
 * @param attempt The attempt number (1-based)
 * @returns Delay in milliseconds
 */
export function calculateBackoff(attempt: number): number {
  // attempt 1 -> 1 min, attempt 2 -> 2 min, attempt 3 -> 4 min, etc.
  const delay = BASE_BACKOFF_MS * Math.pow(2, attempt - 1);
  return Math.min(delay, MAX_BACKOFF_MS);
}

/**
 * Creates a new job in the queue.
 *
 * @param options Job creation options
 * @returns The created job
 */
export async function createJob<T extends JobType>(options: CreateJobOptions<T>): Promise<Job> {
  const { type, payload, scheduledFor = new Date(), maxAttempts = 3 } = options;

  const id = generateUuidv7();

  const [job] = await db
    .insert(jobs)
    .values({
      id,
      type,
      payload: JSON.stringify(payload),
      scheduledFor,
      maxAttempts,
      status: "pending",
      attempts: 0,
    })
    .returning();

  return job;
}

/**
 * Claims a pending job for processing using row locking.
 *
 * Uses SELECT FOR UPDATE SKIP LOCKED to ensure only one worker
 * can claim a job at a time, without blocking other workers.
 *
 * @param options Claim options (optional type filter)
 * @returns The claimed job, or null if no jobs are available
 */
export async function claimJob(options: ClaimJobOptions = {}): Promise<Job | null> {
  const { types } = options;
  const now = new Date();

  // Use a raw SQL query with FOR UPDATE SKIP LOCKED
  // This atomically finds and locks a job that:
  // 1. Has status 'pending'
  // 2. Is scheduled for now or earlier
  // 3. Matches the type filter (if provided)
  const typeFilter =
    types && types.length > 0
      ? sql`AND type = ANY(ARRAY[${sql.join(
          types.map((t) => sql`${t}`),
          sql`, `
        )}]::text[])`
      : sql``;

  const result = await db.execute<RawJobRow>(sql`
    UPDATE ${jobs}
    SET
      status = 'running',
      started_at = ${now},
      attempts = attempts + 1
    WHERE id = (
      SELECT id FROM ${jobs}
      WHERE status = 'pending'
        AND scheduled_for <= ${now}
        ${typeFilter}
      ORDER BY scheduled_for ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING *
  `);

  if (result.rows.length === 0) {
    return null;
  }

  return rowToJob(result.rows[0]);
}

/**
 * Marks a job as completed.
 *
 * @param jobId The ID of the job to complete
 * @returns The updated job
 * @throws Error if the job is not found
 */
export async function completeJob(jobId: string): Promise<Job> {
  const now = new Date();

  const [job] = await db
    .update(jobs)
    .set({
      status: "completed",
      completedAt: now,
    })
    .where(eq(jobs.id, jobId))
    .returning();

  if (!job) {
    throw new Error(`Job not found: ${jobId}`);
  }

  return job;
}

/**
 * Marks a job as failed and handles retries.
 *
 * If the job has not exceeded max attempts, it will be rescheduled
 * with exponential backoff. Otherwise, it will be marked as failed.
 *
 * @param jobId The ID of the job to fail
 * @param error The error message
 * @returns The updated job
 * @throws Error if the job is not found
 */
export async function failJob(jobId: string, error: string): Promise<Job> {
  const now = new Date();

  // First, get the current job state
  const [currentJob] = await db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);

  if (!currentJob) {
    throw new Error(`Job not found: ${jobId}`);
  }

  // Check if we should retry
  const shouldRetry = currentJob.attempts < currentJob.maxAttempts;

  if (shouldRetry) {
    // Calculate next retry time with exponential backoff
    const backoffMs = calculateBackoff(currentJob.attempts);
    const nextRetryAt = new Date(now.getTime() + backoffMs);

    const [job] = await db
      .update(jobs)
      .set({
        status: "pending",
        startedAt: null,
        scheduledFor: nextRetryAt,
        lastError: error,
      })
      .where(eq(jobs.id, jobId))
      .returning();

    return job;
  } else {
    // Max retries exceeded, mark as failed permanently
    const [job] = await db
      .update(jobs)
      .set({
        status: "failed",
        completedAt: now,
        lastError: error,
      })
      .where(eq(jobs.id, jobId))
      .returning();

    return job;
  }
}

/**
 * Gets a job by ID.
 *
 * @param jobId The ID of the job
 * @returns The job, or null if not found
 */
export async function getJob(jobId: string): Promise<Job | null> {
  const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);

  return job ?? null;
}

/**
 * Gets the parsed payload for a job.
 *
 * @param job The job
 * @returns The parsed payload
 */
export function getJobPayload<T extends JobType>(job: Job): JobPayloads[T] {
  return JSON.parse(job.payload) as JobPayloads[T];
}

/**
 * Lists jobs with optional filtering.
 *
 * @param options Filter options
 * @returns List of jobs
 */
export async function listJobs(
  options: {
    status?: Job["status"];
    type?: JobType;
    limit?: number;
  } = {}
): Promise<Job[]> {
  const { status, type, limit = 100 } = options;

  const conditions = [];
  if (status) {
    conditions.push(eq(jobs.status, status));
  }
  if (type) {
    conditions.push(eq(jobs.type, type));
  }

  const query = db.select().from(jobs).orderBy(desc(jobs.scheduledFor)).limit(limit);

  if (conditions.length > 0) {
    return query.where(and(...conditions));
  }

  return query;
}

/**
 * Deletes completed jobs older than a specified date.
 * Useful for cleanup.
 *
 * @param olderThan Delete jobs completed before this date
 * @returns Number of deleted jobs
 */
export async function deleteCompletedJobs(olderThan: Date): Promise<number> {
  const result = await db
    .delete(jobs)
    .where(and(eq(jobs.status, "completed"), lte(jobs.completedAt, olderThan)))
    .returning({ id: jobs.id });

  return result.length;
}

/**
 * Resets stale running jobs that may have been abandoned.
 * Jobs are considered stale if they've been running for longer than the timeout.
 *
 * @param timeoutMs Timeout in milliseconds (default: 5 minutes)
 * @returns Number of reset jobs
 */
export async function resetStaleJobs(timeoutMs: number = 5 * 60 * 1000): Promise<number> {
  const staleThreshold = new Date(Date.now() - timeoutMs);

  const result = await db
    .update(jobs)
    .set({
      status: "pending",
      startedAt: null,
    })
    .where(and(eq(jobs.status, "running"), lte(jobs.startedAt, staleThreshold)))
    .returning({ id: jobs.id });

  return result.length;
}

/**
 * Postgres-based job queue implementation.
 *
 * Uses a "one job per task" model where jobs are persistent scheduled tasks
 * rather than ephemeral run records. For example, each feed has exactly one
 * fetch_feed job that gets updated after each run.
 *
 * Uses row locking (SELECT FOR UPDATE SKIP LOCKED) for concurrent job claiming,
 * ensuring only one worker can process a job at a time.
 *
 * See docs/job-queue-design.md for detailed documentation.
 */

import { eq, sql, and } from "drizzle-orm";
import { db } from "../db";
import { jobs, subscriptions, type Job } from "../db/schema";
import { generateUuidv7 } from "../../lib/uuidv7";

/**
 * Raw job row returned from SQL queries (dates are strings).
 */
type RawJobRow = {
  id: string;
  type: string;
  payload: string;
  enabled: boolean;
  next_run_at: string | null;
  running_since: string | null;
  last_run_at: string | null;
  last_error: string | null;
  consecutive_failures: number;
  created_at: string;
  updated_at: string;
} & Record<string, unknown>;

/**
 * Converts a raw SQL row to a Job with proper Date objects.
 */
function rowToJob(row: RawJobRow): Job {
  return {
    id: row.id,
    type: row.type,
    payload: row.payload,
    enabled: row.enabled,
    nextRunAt: row.next_run_at ? new Date(row.next_run_at) : null,
    runningSince: row.running_since ? new Date(row.running_since) : null,
    lastRunAt: row.last_run_at ? new Date(row.last_run_at) : null,
    lastError: row.last_error,
    consecutiveFailures: row.consecutive_failures,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

/**
 * Job payload types for different job types.
 */
export interface JobPayloads {
  fetch_feed: { feedId: string };
  renew_websub: Record<string, never>; // Empty payload - renews all expiring subscriptions
}

export type JobType = keyof JobPayloads;

/**
 * Stale job threshold in milliseconds.
 * Jobs running longer than this are assumed to have crashed and can be reclaimed.
 */
const STALE_JOB_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Options for creating a new job.
 */
export interface CreateJobOptions<T extends JobType> {
  type: T;
  payload: JobPayloads[T];
  nextRunAt?: Date;
  enabled?: boolean;
}

/**
 * Options for claiming a job.
 */
export interface ClaimJobOptions {
  types?: JobType[];
}

/**
 * Options for finishing a job.
 */
export interface FinishJobOptions {
  success: boolean;
  nextRunAt: Date;
  error?: string;
}

/**
 * Creates a new job in the queue.
 * This should only be called when creating a new scheduled task
 * (e.g., when a feed is first subscribed to).
 *
 * @param options Job creation options
 * @returns The created job
 */
export async function createJob<T extends JobType>(options: CreateJobOptions<T>): Promise<Job> {
  const { type, payload, nextRunAt = new Date(), enabled = true } = options;

  const id = generateUuidv7();
  const now = new Date();

  const [job] = await db
    .insert(jobs)
    .values({
      id,
      type,
      payload: JSON.stringify(payload),
      enabled,
      nextRunAt,
      createdAt: now,
      updatedAt: now,
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
 * Jobs are claimed if:
 * - enabled = true
 * - next_run_at <= now
 * - running_since is NULL OR older than stale threshold (5 minutes)
 *
 * @param options Claim options (optional type filter)
 * @returns The claimed job, or null if no jobs are available
 */
export async function claimJob(options: ClaimJobOptions = {}): Promise<Job | null> {
  const { types } = options;
  const now = new Date();
  const staleThreshold = new Date(now.getTime() - STALE_JOB_THRESHOLD_MS);

  // Build type filter if provided
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
      running_since = ${now},
      updated_at = ${now}
    WHERE id = (
      SELECT id FROM ${jobs}
      WHERE enabled = true
        AND next_run_at <= ${now}
        AND (running_since IS NULL OR running_since < ${staleThreshold})
        ${typeFilter}
      ORDER BY next_run_at ASC
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
 * Finishes a job after execution, updating its state for the next run.
 *
 * On success:
 * - running_since = NULL
 * - last_run_at = now
 * - next_run_at = provided value
 * - last_error = NULL
 * - consecutive_failures = 0
 *
 * On failure:
 * - running_since = NULL
 * - last_run_at = now
 * - next_run_at = provided value (should include backoff)
 * - last_error = provided error
 * - consecutive_failures++
 *
 * @param jobId The ID of the job to finish
 * @param options Finish options
 * @returns The updated job
 */
export async function finishJob(jobId: string, options: FinishJobOptions): Promise<Job> {
  const { success, nextRunAt, error } = options;
  const now = new Date();

  if (success) {
    const [job] = await db
      .update(jobs)
      .set({
        runningSince: null,
        lastRunAt: now,
        nextRunAt,
        lastError: null,
        consecutiveFailures: 0,
        updatedAt: now,
      })
      .where(eq(jobs.id, jobId))
      .returning();

    if (!job) {
      throw new Error(`Job not found: ${jobId}`);
    }

    return job;
  } else {
    // For failure, increment consecutive_failures
    const [job] = await db
      .update(jobs)
      .set({
        runningSince: null,
        lastRunAt: now,
        nextRunAt,
        lastError: error ?? "Unknown error",
        consecutiveFailures: sql`${jobs.consecutiveFailures} + 1`,
        updatedAt: now,
      })
      .where(eq(jobs.id, jobId))
      .returning();

    if (!job) {
      throw new Error(`Job not found: ${jobId}`);
    }

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
 * Gets a feed job by feed ID.
 *
 * @param feedId The feed ID
 * @returns The job, or null if not found
 */
export async function getFeedJob(feedId: string): Promise<Job | null> {
  const result = await db.execute<RawJobRow>(sql`
    SELECT * FROM ${jobs}
    WHERE type = 'fetch_feed'
      AND payload::json->>'feedId' = ${feedId}
    LIMIT 1
  `);

  if (result.rows.length === 0) {
    return null;
  }

  return rowToJob(result.rows[0]);
}

/**
 * Creates or enables a job for a feed.
 * Idempotent - if a job already exists, enables it if disabled.
 *
 * @param feedId The feed ID
 * @param nextRunAt When the job should run (default: now)
 * @returns The job (created or updated)
 */
export async function createOrEnableFeedJob(feedId: string, nextRunAt?: Date): Promise<Job> {
  const now = new Date();
  const runAt = nextRunAt ?? now;

  // Try to enable existing job first
  const result = await db.execute<RawJobRow>(sql`
    UPDATE ${jobs}
    SET
      enabled = true,
      next_run_at = COALESCE(next_run_at, ${runAt}),
      updated_at = ${now}
    WHERE type = 'fetch_feed'
      AND payload::json->>'feedId' = ${feedId}
    RETURNING *
  `);

  if (result.rows.length > 0) {
    return rowToJob(result.rows[0]);
  }

  // No existing job, create new one
  return createJob({
    type: "fetch_feed",
    payload: { feedId },
    nextRunAt: runAt,
    enabled: true,
  });
}

/**
 * Enables a feed job if it exists and is disabled.
 * Returns the job's next_run_at so it can be synced to feeds.next_fetch_at.
 *
 * @param feedId The feed ID
 * @returns The job if found and enabled, null otherwise
 */
export async function enableFeedJob(feedId: string): Promise<Job | null> {
  const now = new Date();

  const result = await db.execute<RawJobRow>(sql`
    UPDATE ${jobs}
    SET
      enabled = true,
      updated_at = ${now}
    WHERE type = 'fetch_feed'
      AND payload::json->>'feedId' = ${feedId}
    RETURNING *
  `);

  if (result.rows.length === 0) {
    return null;
  }

  return rowToJob(result.rows[0]);
}

/**
 * Syncs a feed job's enabled state based on whether the feed has active subscribers.
 * This should be called after a subscription is deleted to check if the job should be disabled.
 *
 * @param feedId The feed ID
 * @returns Object with the job's new enabled state, or null if job not found
 */
export async function syncFeedJobEnabled(
  feedId: string
): Promise<{ enabled: boolean; job: Job } | null> {
  const now = new Date();

  // Atomically update enabled based on whether there are active subscribers
  const result = await db.execute<RawJobRow>(sql`
    UPDATE ${jobs}
    SET
      enabled = EXISTS (
        SELECT 1 FROM ${subscriptions}
        WHERE ${subscriptions.feedId} = ${feedId}
          AND ${subscriptions.unsubscribedAt} IS NULL
      ),
      updated_at = ${now}
    WHERE type = 'fetch_feed'
      AND payload::json->>'feedId' = ${feedId}
    RETURNING *
  `);

  if (result.rows.length === 0) {
    return null;
  }

  const job = rowToJob(result.rows[0]);
  return { enabled: job.enabled, job };
}

/**
 * Updates a feed job's next_run_at.
 * Used by WebSub to schedule backup polls.
 *
 * @param feedId The feed ID
 * @param nextRunAt The new next run time
 * @returns The updated job, or null if not found
 */
export async function updateFeedJobNextRun(feedId: string, nextRunAt: Date): Promise<Job | null> {
  const now = new Date();

  const result = await db.execute<RawJobRow>(sql`
    UPDATE ${jobs}
    SET
      next_run_at = ${nextRunAt},
      updated_at = ${now}
    WHERE type = 'fetch_feed'
      AND payload::json->>'feedId' = ${feedId}
    RETURNING *
  `);

  if (result.rows.length === 0) {
    return null;
  }

  return rowToJob(result.rows[0]);
}

/**
 * Lists jobs with optional filtering.
 *
 * @param options Filter options
 * @returns List of jobs
 */
export async function listJobs(
  options: {
    enabled?: boolean;
    type?: JobType;
    limit?: number;
  } = {}
): Promise<Job[]> {
  const { enabled, type, limit = 100 } = options;

  const conditions = [];
  if (enabled !== undefined) {
    conditions.push(eq(jobs.enabled, enabled));
  }
  if (type) {
    conditions.push(eq(jobs.type, type));
  }

  const query = db.select().from(jobs).limit(limit);

  if (conditions.length > 0) {
    return query.where(and(...conditions));
  }

  return query;
}

/**
 * Ensures the renew_websub job exists.
 * Creates it if it doesn't exist, does nothing if it does.
 * Should be called at application startup.
 *
 * @returns The job (created or existing)
 */
export async function ensureRenewWebsubJobExists(): Promise<Job> {
  // Check if job already exists
  const [existingJob] = await db.select().from(jobs).where(eq(jobs.type, "renew_websub")).limit(1);

  if (existingJob) {
    return existingJob;
  }

  // Create the job
  return createJob({
    type: "renew_websub",
    payload: {},
    nextRunAt: new Date(),
    enabled: true,
  });
}

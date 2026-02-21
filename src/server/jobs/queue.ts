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
 * Job eligibility is data-driven: instead of an "enabled" flag, jobs are
 * claimed based on the actual data state. For example, feed jobs are only
 * claimed if the feed has active subscribers.
 *
 * See docs/job-queue-design.md for detailed documentation.
 */

import { eq, sql } from "drizzle-orm";
import { db } from "../db";
import { jobs, type Job } from "../db/schema";
import { generateUuidv7 } from "../../lib/uuidv7";

/**
 * Raw job row returned from SQL queries (dates are strings).
 */
type RawJobRow = {
  id: string;
  type: string;
  payload: Record<string, unknown>;
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
  process_opml_import: { importId: string }; // Process an OPML import in the background
  train_score_model: { userId: string }; // Train ML model for score prediction
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
  const { type, payload, nextRunAt = new Date() } = options;

  const id = generateUuidv7();
  const now = new Date();

  const [job] = await db
    .insert(jobs)
    .values({
      id,
      type,
      payload,
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
 * - next_run_at <= now
 * - running_since is NULL OR older than stale threshold (5 minutes)
 *
 * Note: This only claims non-feed jobs (process_opml_import, etc.).
 * Feed jobs are claimed via claimFeedJob() which checks for active subscribers.
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
      WHERE next_run_at <= ${now}
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
  return job.payload as JobPayloads[T];
}

/**
 * Ensures a job exists for a feed.
 * Idempotent - if a job already exists, updates next_run_at if not already set.
 *
 * In the data-driven model, job eligibility is determined by whether the feed
 * has active subscribers, not by an enabled flag. This function just ensures
 * the job row exists for tracking scheduling state.
 *
 * @param feedId The feed ID
 * @param nextRunAt When the job should run (default: now)
 * @returns The job (created or existing)
 */
export async function ensureFeedJob(feedId: string, nextRunAt?: Date): Promise<Job> {
  const now = new Date();
  const runAt = nextRunAt ?? now;

  // Try to update existing job's next_run_at if it's null
  const result = await db.execute<RawJobRow>(sql`
    UPDATE ${jobs}
    SET
      next_run_at = COALESCE(next_run_at, ${runAt}),
      updated_at = ${now}
    WHERE type = 'fetch_feed'
      AND payload->>'feedId' = ${feedId}
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
  });
}

/**
 * @deprecated Use ensureFeedJob instead. This alias exists for backwards compatibility.
 */
export const createOrEnableFeedJob = ensureFeedJob;

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
      AND payload->>'feedId' = ${feedId}
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
    type?: JobType;
    limit?: number;
  } = {}
): Promise<Job[]> {
  const { type, limit = 100 } = options;

  if (type) {
    return db.select().from(jobs).where(eq(jobs.type, type)).limit(limit);
  }

  return db.select().from(jobs).limit(limit);
}

/**
 * Singleton job types that have exactly one instance and self-create on first run.
 */
const SINGLETON_JOB_TYPES: JobType[] = ["renew_websub"];

/**
 * Tries to claim a singleton job for processing.
 *
 * Singleton jobs (like renew_websub) have exactly one row. If no row exists,
 * that means "run now" - the row is created on first run and tracks next_run_at.
 *
 * @param type - The singleton job type to claim
 * @returns The claimed job, or null if not due or already running
 */
export async function claimSingletonJob(type: JobType): Promise<Job | null> {
  if (!SINGLETON_JOB_TYPES.includes(type)) {
    throw new Error(`${type} is not a singleton job type`);
  }

  const now = new Date();
  const staleThreshold = new Date(now.getTime() - STALE_JOB_THRESHOLD_MS);

  // First, try to claim an existing job
  const claimResult = await db.execute<RawJobRow>(sql`
    UPDATE ${jobs}
    SET
      running_since = ${now},
      updated_at = ${now}
    WHERE type = ${type}
      AND next_run_at <= ${now}
      AND (running_since IS NULL OR running_since < ${staleThreshold})
    RETURNING *
  `);

  if (claimResult.rows.length > 0) {
    return rowToJob(claimResult.rows[0]);
  }

  // No claimable job - check if a job exists at all
  const [existingJob] = await db.select().from(jobs).where(eq(jobs.type, type)).limit(1);

  if (existingJob) {
    // Job exists but isn't due or is currently running
    return null;
  }

  // No job exists - create one and claim it immediately
  // Use a transaction to handle race conditions (two workers both see no row)
  try {
    const [newJob] = await db
      .insert(jobs)
      .values({
        id: generateUuidv7(),
        type,
        payload: {},
        nextRunAt: now,
        runningSince: now,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    return newJob;
  } catch {
    // Another worker likely created the job - try to claim it
    const retryResult = await db.execute<RawJobRow>(sql`
      UPDATE ${jobs}
      SET
        running_since = ${now},
        updated_at = ${now}
      WHERE type = ${type}
        AND (running_since IS NULL OR running_since < ${staleThreshold})
      RETURNING *
    `);

    if (retryResult.rows.length > 0) {
      return rowToJob(retryResult.rows[0]);
    }

    // Job exists and is running - that's fine
    return null;
  }
}

/**
 * Claims a feed job for processing using data-driven eligibility.
 *
 * A feed job is eligible if:
 * - The feed has at least one active subscriber (subscription with no unsubscribed_at)
 * - The job's next_run_at <= now
 * - The job is not already running (or is stale)
 *
 * This ensures we only fetch feeds that users actually care about.
 *
 * @returns The claimed job, or null if no eligible feed jobs
 */
export async function claimFeedJob(): Promise<Job | null> {
  const now = new Date();
  const staleThreshold = new Date(now.getTime() - STALE_JOB_THRESHOLD_MS);

  // Claim a feed job only if the feed has active subscribers
  // We use EXISTS instead of JOIN + GROUP BY to allow FOR UPDATE
  const result = await db.execute<RawJobRow>(sql`
    UPDATE jobs
    SET
      running_since = ${now},
      updated_at = ${now}
    WHERE id = (
      SELECT j.id FROM jobs j
      WHERE j.type = 'fetch_feed'
        AND j.next_run_at <= ${now}
        AND (j.running_since IS NULL OR j.running_since < ${staleThreshold})
        AND EXISTS (
          SELECT 1 FROM subscriptions s
          WHERE s.feed_id = (j.payload->>'feedId')::uuid
            AND s.unsubscribed_at IS NULL
        )
      ORDER BY j.next_run_at ASC
      LIMIT 1
      FOR UPDATE OF j SKIP LOCKED
    )
    RETURNING *
  `);

  if (result.rows.length === 0) {
    return null;
  }

  return rowToJob(result.rows[0]);
}

/**
 * Claims a score training job for processing using data-driven eligibility.
 *
 * A user needs score training if:
 * - They have at least 20 entries with scoring signals (explicit score, starred, etc.)
 * - Either they have no model, or the model is older than 24 hours
 *
 * This queries the actual user data to determine eligibility.
 *
 * @returns The claimed job, or null if no eligible training jobs
 */
export async function claimScoreTrainingJob(): Promise<Job | null> {
  const now = new Date();
  const staleThreshold = new Date(now.getTime() - STALE_JOB_THRESHOLD_MS);
  const modelAgeThreshold = new Date(now.getTime() - 24 * 60 * 60 * 1000); // 24 hours

  // Find a user who needs training:
  // - Has algorithmic feed enabled
  // - Has 20+ scored entries
  // - Model is missing OR model is stale (> 24h old)
  // - Doesn't have a training job currently running
  const result = await db.execute<RawJobRow>(sql`
    WITH users_needing_training AS (
      SELECT ue.user_id
      FROM user_entries ue
      INNER JOIN entries e ON e.id = ue.entry_id
      INNER JOIN users u ON u.id = ue.user_id
      WHERE u.algorithmic_feed_enabled = true
        AND (ue.score IS NOT NULL
         OR ue.has_starred = true
         OR ue.has_marked_unread = true
         OR ue.has_marked_read_on_list = true
         OR e.type = 'saved')
      GROUP BY ue.user_id
      HAVING count(*) >= 20
    ),
    users_with_stale_model AS (
      SELECT unt.user_id
      FROM users_needing_training unt
      LEFT JOIN user_score_models usm ON usm.user_id = unt.user_id
      WHERE usm.user_id IS NULL
         OR usm.trained_at < ${modelAgeThreshold}
    )
    UPDATE jobs
    SET
      running_since = ${now},
      updated_at = ${now}
    WHERE id = (
      SELECT j.id FROM jobs j
      INNER JOIN users_with_stale_model uwsm ON (j.payload->>'userId')::uuid = uwsm.user_id
      WHERE j.type = 'train_score_model'
        AND j.next_run_at <= ${now}
        AND (j.running_since IS NULL OR j.running_since < ${staleThreshold})
      ORDER BY j.next_run_at ASC
      LIMIT 1
      FOR UPDATE OF j SKIP LOCKED
    )
    RETURNING *
  `);

  if (result.rows.length > 0) {
    return rowToJob(result.rows[0]);
  }

  // No claimable job row - ensure job rows exist for eligible users who don't have one.
  // Like ensureFeedJob/claimSingletonJob, the row is created once and reused for scheduling.
  const usersNeedingJobs = await db.execute<{ user_id: string }>(sql`
    WITH users_needing_training AS (
      SELECT ue.user_id
      FROM user_entries ue
      INNER JOIN entries e ON e.id = ue.entry_id
      INNER JOIN users u ON u.id = ue.user_id
      WHERE u.algorithmic_feed_enabled = true
        AND (ue.score IS NOT NULL
         OR ue.has_starred = true
         OR ue.has_marked_unread = true
         OR ue.has_marked_read_on_list = true
         OR e.type = 'saved')
      GROUP BY ue.user_id
      HAVING count(*) >= 20
    )
    SELECT unt.user_id
    FROM users_needing_training unt
    WHERE NOT EXISTS (
      SELECT 1 FROM jobs j
      WHERE j.type = 'train_score_model'
        AND (j.payload->>'userId')::uuid = unt.user_id
    )
  `);

  for (const row of usersNeedingJobs.rows) {
    await createJob({
      type: "train_score_model",
      payload: { userId: row.user_id },
    });
  }

  return null;
}

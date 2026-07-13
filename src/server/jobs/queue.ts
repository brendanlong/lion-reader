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

import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { jobs, type Job } from "../db/schema";
import { isUniqueViolation } from "../db/errors";
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
  // `forceReprocessRequestedAt` is a one-shot request set by
  // `scheduleFeedRefreshNow` (the interactive subscribe path forcing a refresh
  // of a stale feed). Its presence makes the fetch reprocess and re-stamp
  // visibility unconditionally so a brand-new subscriber is fanned out even when
  // the feed hasn't changed. The value is the request time, used as an
  // optimistic-concurrency token: the worker records it at claim and, on a
  // successful run, consumes it via `finishJob({ consumeForceReprocess })` only
  // if it hasn't changed since — a subscribe that re-arms the shared job
  // mid-run bumps the token, so the consume leaves it in place and the fetch
  // re-runs (covering the late subscriber) instead of dropping the request. A
  // failed run keeps it so the retry re-forces.
  fetch_feed: { feedId: string; forceReprocessRequestedAt?: string };
  renew_websub: Record<string, never>; // Empty payload - renews all expiring subscriptions
  process_opml_import: { importId: string }; // Process an OPML import in the background
  // Periodic feed fetch health check. Empty payload — alert cadence and
  // de-duplication are owned by the external healthchecks.io monitor, so no
  // state is carried across runs.
  monitor_feed_health: Record<string, never>;
  // Daily retention cleanup of expired/revoked credentials and parked
  // one-time jobs. See src/server/services/retention.ts.
  cleanup: Record<string, never>;
  // Daily self-healing sweep of the denormalized unread counters (issue
  // #1117). See src/server/services/reconcile-counters.ts.
  reconcile_counters: Record<string, never>;
}

export type JobType = keyof JobPayloads;

/**
 * Stale job threshold in milliseconds.
 * Jobs running longer than this are assumed to have crashed and can be reclaimed.
 *
 * A running job is not reclaimed merely because it is slow: its worker renews
 * the lease (`running_since`) via {@link renewJobLease} every
 * {@link JOB_LEASE_HEARTBEAT_MS}, so this threshold is only crossed when the
 * worker process has actually stopped heartbeating (crashed/killed). That keeps
 * stale-job recovery from running a still-executing, non-idempotent handler in a
 * second worker concurrently (issue #871).
 */
const STALE_JOB_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

/**
 * How often a worker renews the lease on a job it is actively running.
 *
 * Must be comfortably smaller than {@link STALE_JOB_THRESHOLD_MS} so that a few
 * missed heartbeats (GC pause, slow DB write) don't cause a live job to be
 * reclaimed. At 1 minute vs. the 5-minute threshold, ~5 consecutive renewals
 * must fail before a job becomes reclaimable.
 */
export const JOB_LEASE_HEARTBEAT_MS = 60 * 1000; // 1 minute

/**
 * Base delay before retrying a job whose handler threw: 1 minute.
 */
const EXCEPTION_RETRY_BASE_MS = 60 * 1000;

/**
 * Maximum delay between retries of a job whose handler keeps throwing: 24 hours.
 */
const EXCEPTION_RETRY_MAX_MS = 24 * 60 * 60 * 1000;

/**
 * Calculates the retry delay for a job whose handler threw an exception.
 *
 * Handlers that fail gracefully return their own nextRunAt (feed fetches use
 * calculateNextFetch's failure backoff), but an unexpected throw used to be
 * retried on a flat 60s forever — a deterministically-throwing handler would
 * hammer its remote host every minute (issue #953). Instead, mirror the feed
 * failure backoff: exponential from 1 minute, doubling per consecutive
 * failure, capped at 24 hours (1m, 2m, 4m, ... ~17h, 24h).
 *
 * @param consecutiveFailures - The job's failure count *before* this failure
 *   (i.e. `job.consecutiveFailures` as claimed; finishJob increments it)
 * @returns Delay in milliseconds until the next retry
 */
export function calculateExceptionRetryDelayMs(consecutiveFailures: number): number {
  const exponent = Math.max(0, consecutiveFailures);
  // Avoid overflow for huge failure counts: past 2^31 the cap always wins.
  if (exponent >= 31) {
    return EXCEPTION_RETRY_MAX_MS;
  }
  return Math.min(EXCEPTION_RETRY_BASE_MS * 2 ** exponent, EXCEPTION_RETRY_MAX_MS);
}

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
  /**
   * On a **successful** fetch_feed finish, consume the one-shot
   * `forceReprocessRequestedAt` request (see {@link scheduleFeedRefreshNow}) with
   * optimistic concurrency. Pass the token observed at claim (`claimedAt`, or
   * `null` if the claimed job carried no request — an ordinary poll):
   *
   * - if the row's current `forceReprocessRequestedAt` still equals `claimedAt`,
   *   the request is satisfied → it's removed and `nextRunAt` (normal cadence)
   *   is used;
   * - otherwise a request is pending that this run didn't satisfy (a subscribe
   *   re-armed the shared job mid-run, or an ordinary poll finished while a
   *   request landed) → it's left in place and `next_run_at` is set to now so
   *   the forced refresh runs promptly.
   *
   * Ignored on a failed finish (the request is kept so the retry re-forces).
   * Omit for non-fetch_feed jobs.
   */
  consumeForceReprocess?: { claimedAt: string | null };
  /**
   * The `running_since` value this worker last held (its lease token). When
   * provided, the finish is fenced on it: if another worker has since reclaimed
   * the job (different `running_since`), the update applies to no rows and
   * {@link finishJob} returns null instead of clobbering the new owner's state.
   * Omit only for callers that aren't holding a lease (e.g. tests).
   */
  expectedRunningSince?: Date;
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
 * When `expectedRunningSince` is supplied (the worker's lease token), the write
 * is fenced on it so a worker that lost its lease — it stalled past the stale
 * threshold and another worker reclaimed the job — can't clobber the new owner's
 * row or clear `running_since` out from under a job that's actively running
 * elsewhere. In that case no row matches and this returns null.
 *
 * @param jobId The ID of the job to finish
 * @param options Finish options
 * @returns The updated job, or null if the lease was lost (only possible when
 *   `expectedRunningSince` is supplied)
 */
export async function finishJob(jobId: string, options: FinishJobOptions): Promise<Job | null> {
  const { success, nextRunAt, error, consumeForceReprocess, expectedRunningSince } = options;
  const now = new Date();

  // Fence on the lease token when the caller holds one (see FinishJobOptions).
  const whereClause = expectedRunningSince
    ? and(eq(jobs.id, jobId), eq(jobs.runningSince, expectedRunningSince))
    : eq(jobs.id, jobId);

  // On a successful fetch_feed finish, optimistically consume the one-shot
  // forceReprocess request (see FinishJobOptions.consumeForceReprocess). The
  // comparison and rewrite happen in one atomic UPDATE so a subscribe that
  // re-armed the shared job mid-run can't be clobbered: if the token is
  // unchanged we consume it and use the normal cadence; otherwise we leave the
  // pending request and pull the next run to now. `IS NOT DISTINCT FROM` makes
  // the null (ordinary-poll) case null-safe.
  const claimedAt = consumeForceReprocess?.claimedAt ?? null;
  const tokenMatches = sql`${jobs.payload} ->> 'forceReprocessRequestedAt' IS NOT DISTINCT FROM ${claimedAt}`;
  const nextRunAtExpr = consumeForceReprocess
    ? sql`CASE WHEN ${tokenMatches} THEN ${nextRunAt}::timestamptz ELSE ${now}::timestamptz END`
    : nextRunAt;
  // Only strip the token when this run actually claimed one (claimedAt not null)
  // and it still matches — otherwise leave any pending request untouched.
  const payloadUpdate =
    consumeForceReprocess && claimedAt !== null
      ? {
          payload: sql`CASE WHEN ${tokenMatches} THEN ${jobs.payload} - 'forceReprocessRequestedAt' ELSE ${jobs.payload} END`,
        }
      : {};

  const [job] = success
    ? await db
        .update(jobs)
        .set({
          runningSince: null,
          lastRunAt: now,
          nextRunAt: nextRunAtExpr,
          lastError: null,
          consecutiveFailures: 0,
          updatedAt: now,
          ...payloadUpdate,
        })
        .where(whereClause)
        .returning()
    : await db
        .update(jobs)
        .set({
          runningSince: null,
          lastRunAt: now,
          nextRunAt,
          lastError: error ?? "Unknown error",
          // For failure, increment consecutive_failures
          consecutiveFailures: sql`${jobs.consecutiveFailures} + 1`,
          updatedAt: now,
        })
        .where(whereClause)
        .returning();

  if (!job) {
    // A fenced write that matches no row means the lease was lost to another
    // worker — expected, not an error. An unfenced miss means the job is gone.
    if (expectedRunningSince) {
      return null;
    }
    throw new Error(`Job not found: ${jobId}`);
  }

  return job;
}

/**
 * Renews the lease on a running job by bumping `running_since` to now.
 *
 * Workers call this on a heartbeat (every {@link JOB_LEASE_HEARTBEAT_MS}) while a
 * handler is in flight. Because the lease keeps moving forward, stale-job
 * recovery (which reclaims jobs whose `running_since` is older than
 * {@link STALE_JOB_THRESHOLD_MS}) only fires once the worker stops heartbeating —
 * i.e. the worker process has died or frozen — never while the handler is still
 * actively heartbeating. This is what prevents a slow or
 * timed-out-but-still-running handler from being reclaimed and executed
 * concurrently in a second worker (issue #871).
 *
 * The `running_since` value the worker last wrote acts as a **fencing token**:
 * the update only applies if the row still holds `expectedRunningSince`. If a
 * worker stalls past the stale threshold and a second worker reclaims the job
 * (overwriting `running_since` with its own value), the first worker's delayed
 * heartbeat finds the token no longer matches and returns null — so it can't
 * steal the lease back from the new owner (no split-brain). A heartbeat racing
 * with {@link finishJob} (which clears `running_since`) likewise no-ops.
 *
 * @param jobId The ID of the running job
 * @param expectedRunningSince The `running_since` value this worker last wrote
 * @returns The new `running_since` on success, or null if the lease was lost
 */
export async function renewJobLease(
  jobId: string,
  expectedRunningSince: Date
): Promise<Date | null> {
  const now = new Date();

  const renewed = await db
    .update(jobs)
    .set({ runningSince: now, updatedAt: now })
    .where(and(eq(jobs.id, jobId), eq(jobs.runningSince, expectedRunningSince)))
    .returning({ runningSince: jobs.runningSince });

  return renewed.length > 0 ? renewed[0].runningSince : null;
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
  const id = generateUuidv7();

  // Single upsert keyed on the partial unique index idx_jobs_feed_id
  // (one fetch_feed row per feedId). The previous UPDATE-then-INSERT was
  // check-then-act: two concurrent subscribes to the same feed could both find
  // no row and both insert, creating duplicate fetch jobs that then fetched the
  // feed twice every cycle forever (issue #952). ON CONFLICT makes this atomic.
  //
  // On conflict we keep an existing non-null next_run_at (don't disturb a feed
  // that's already scheduled/backing off) but fill it in if it was null —
  // matching the previous COALESCE(next_run_at, runAt) behavior.
  const result = await db.execute<RawJobRow>(sql`
    INSERT INTO ${jobs} (id, type, payload, next_run_at, created_at, updated_at)
    VALUES (${id}, 'fetch_feed', ${JSON.stringify({ feedId })}::jsonb, ${runAt}, ${now}, ${now})
    ON CONFLICT ((payload->>'feedId')) WHERE type = 'fetch_feed'
    DO UPDATE SET
      next_run_at = COALESCE(${jobs.nextRunAt}, ${runAt}),
      updated_at = ${now}
    RETURNING *
  `);

  return rowToJob(result.rows[0]);
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
      AND payload->>'feedId' = ${feedId}
    RETURNING *
  `);

  if (result.rows.length === 0) {
    return null;
  }

  return rowToJob(result.rows[0]);
}

/**
 * Schedules an immediate, force-reprocess fetch of a feed.
 *
 * Used by the interactive subscribe path to refresh a stale feed before a
 * brand-new subscriber's entries are populated: it upserts the feed's single
 * `fetch_feed` job to run now (or sooner, if it was already overdue) and stamps
 * `forceReprocess` on the payload, so the worker fetches unconditionally,
 * re-stamps visibility, and fans out `user_entries` even when the feed hasn't
 * changed (see `handleFetchFeed`). Keeping it on the one per-feed job means
 * concurrent subscribes to the same feed coalesce into a single fetch (the same
 * single-flight guarantee `ensureFeedJob` relies on, issue #952), and it merges
 * cleanly with any pending scheduled poll. The worker consumes the flag on a
 * successful run.
 *
 * @param feedId The feed ID
 * @returns The upserted job
 */
export async function scheduleFeedRefreshNow(feedId: string): Promise<Job> {
  const now = new Date();
  const nowIso = now.toISOString();
  const id = generateUuidv7();

  const result = await db.execute<RawJobRow>(sql`
    INSERT INTO ${jobs} (id, type, payload, next_run_at, created_at, updated_at)
    VALUES (${id}, 'fetch_feed', ${JSON.stringify({ feedId, forceReprocessRequestedAt: nowIso })}::jsonb, ${now}, ${now}, ${now})
    ON CONFLICT ((payload->>'feedId')) WHERE type = 'fetch_feed'
    DO UPDATE SET
      -- Run now, or keep an already-earlier (overdue) time.
      next_run_at = LEAST(COALESCE(${jobs.nextRunAt}, ${now}), ${now}),
      -- Stamp/refresh the request token, preserving feedId and any other keys.
      -- A later request overwrites an earlier one with a strictly greater time,
      -- which the finish-time compare-and-swap uses to detect a mid-run re-arm.
      payload = ${jobs.payload} || jsonb_build_object('forceReprocessRequestedAt', ${nowIso}::text),
      updated_at = ${now}
    RETURNING *
  `);

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
 *
 * ORDERING INVARIANT: the worker's claim loop tries these first-due-wins, in
 * array order. A singleton that reschedules itself near-immediately under
 * backlog must be listed LAST — placed earlier it would be due again on every
 * claim cycle and starve every type after it. The current types reschedule at
 * +15min or slower, so ordering among them is harmless; keep any
 * fast-rescheduling type at the end when adding one.
 */
export const SINGLETON_JOB_TYPES: JobType[] = [
  "renew_websub",
  "monitor_feed_health",
  "cleanup",
  "reconcile_counters",
];

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

  // No job exists - create one and claim it immediately.
  // The jobs_singleton_type_unique partial index makes this INSERT conflict if
  // another worker creates the row first (two workers both see no row), so the
  // catch below handles that race by claiming the row the winner created.
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
  } catch (error) {
    // Only the jobs_singleton_type_unique conflict (Postgres unique_violation,
    // SQLSTATE 23505) means another worker won the race. Any other error is a
    // genuine failure and must propagate rather than be masked as "lost race".
    if (!isUniqueViolation(error)) {
      throw error;
    }

    // Another worker created the job first - try to claim it. Keep the
    // next_run_at <= now check: if the winner already ran and rescheduled the
    // job, we must not immediately re-run it.
    const retryResult = await db.execute<RawJobRow>(sql`
      UPDATE ${jobs}
      SET
        running_since = ${now},
        updated_at = ${now}
      WHERE type = ${type}
        AND next_run_at <= ${now}
        AND (running_since IS NULL OR running_since < ${staleThreshold})
      RETURNING *
    `);

    if (retryResult.rows.length > 0) {
      return rowToJob(retryResult.rows[0]);
    }

    // Job exists and is running or already rescheduled - that's fine
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

/**
 * Postgres-based job queue implementation.
 *
 * Uses a "one job per task" model where jobs are persistent scheduled tasks
 * rather than ephemeral run records. For example, each feed has exactly one
 * fetch_feed job that gets updated after each run.
 *
 * Uses row locking (SELECT FOR UPDATE SKIP LOCKED) for concurrent job claiming,
 * so two workers never claim the same job at once. A job still running past
 * {@link STALE_JOB_THRESHOLD_MS} can be claimed again, so every handler must be
 * idempotent.
 *
 * Job eligibility is data-driven: instead of an "enabled" flag, jobs are
 * claimed based on the actual data state. For example, feed jobs are only
 * claimed if the feed has active subscribers.
 *
 * See src/server/jobs/CLAUDE.md for the overall architecture.
 */

import { eq, sql, type SQL } from "drizzle-orm";
import { db, type DbOrTx } from "../db";
import { jobs, type Job } from "../db/schema";
import { generateUuidv7 } from "../../lib/uuidv7";
import { z } from "zod";

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

function firstJob(result: { rows: RawJobRow[] }): Job | null {
  return result.rows.length === 0 ? null : rowToJob(result.rows[0]);
}

const emptyPayload = z.object({});

/** A user's or an entry's objects prefix (`services/stored-objects.ts`). */
const storedObjectsPrefix = z.string().regex(/^uploads\/[0-9a-f-]{36}\/([0-9a-f-]{36}\/)?$/);

/**
 * Where a job type is claimed (see `createWorkerClaimJob` in worker.ts):
 *
 * - `feed`: the data-driven fetch_feed claim (only feeds with subscribers).
 * - `singleton`: exactly one row, seeded at worker start (see
 *   {@link SINGLETON_JOB_TYPES}).
 * - `one_time`: the generic due-job claim. Each row is a single task, deleted
 *   when its handler returns, whatever the outcome; only a throw keeps the row,
 *   for the worker's backed-off retry.
 * - `full_content`: the concurrency-capped {@link claimFullContentJob}. Also
 *   one-time.
 */
type JobLane = "feed" | "singleton" | "one_time" | "full_content";

type JobDefinition =
  | {
      payload: z.ZodType;
      lane: "singleton";
      /**
       * Under a backlog, reschedules itself near-immediately. Ordered last in
       * {@link SINGLETON_JOB_TYPES} so it can't starve the others.
       */
      reschedulesFast?: true;
      /**
       * Runs every `intervalMs`, measured from each run's start. The worker
       * schedules it, so its handler returns only metadata.
       */
      intervalMs?: number;
    }
  | {
      payload: z.ZodType;
      lane: Exclude<JobLane, "singleton">;
      reschedulesFast?: never;
      intervalMs?: never;
    };

/**
 * Every job type, its payload schema and its claim lane. The worker's handler
 * table (`JOB_HANDLERS` in worker.ts) must cover exactly these keys.
 */
const JOB_DEFINITIONS = {
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
  fetch_feed: {
    payload: z.object({ feedId: z.string(), forceReprocessRequestedAt: z.string().optional() }),
    lane: "feed",
  },
  // Renews all expiring WebSub subscriptions. Hourly: each run renews leases
  // expiring within two intervals (handlers/renew-websub.ts), so a daily
  // cadence would leave sub-day leases unrenewed for most of their life.
  renew_websub: { payload: emptyPayload, lane: "singleton", intervalMs: 60 * 60 * 1000 },
  // Periodic feed fetch health check. Alert cadence and de-duplication are
  // owned by the external healthchecks.io monitor, so no state is carried
  // across runs.
  monitor_feed_health: { payload: emptyPayload, lane: "singleton", intervalMs: 15 * 60 * 1000 },
  // Daily retention cleanup of expired/revoked credentials and dead feed
  // jobs. See src/server/services/retention.ts.
  cleanup: { payload: emptyPayload, lane: "singleton", intervalMs: 24 * 60 * 60 * 1000 },
  // Daily self-healing sweep of the denormalized unread counters (issue
  // #1117), by the membership rules of #1846: the triggers should keep them
  // exact, so this is a drift detector (any fix logs at error level). See
  // src/server/services/reconcile-counters.ts.
  reconcile_membership_counters: {
    payload: emptyPayload,
    lane: "singleton",
    intervalMs: 24 * 60 * 60 * 1000,
  },
  // Fills the Getting Started article in for users who predate it, a batch per
  // run (issue #1397). Stateless — `users.getting_started_at` is the progress
  // marker. See src/server/services/getting-started.ts. While a backlog remains
  // it reschedules itself in seconds.
  backfill_getting_started: { payload: emptyPayload, lane: "singleton", reschedulesFast: true },
  // Process an OPML import in the background.
  process_opml_import: { payload: z.object({ importId: z.string() }), lane: "one_time" },
  // Deletes deleted users' or entries' objects in the public bucket (their
  // images); see src/server/services/stored-objects.ts. Each prefix must be
  // one of those two shapes, so a bad payload can't empty the bucket.
  delete_stored_objects: {
    payload: z.object({ prefixes: z.array(storedObjectsPrefix) }),
    lane: "one_time",
  },
  // Delete the archived full-content pages of hard-deleted entries. Queued in
  // the deleting transaction; see src/server/services/full-content-archive.ts.
  delete_full_content_archives: {
    payload: z.object({ entryIds: z.array(z.string()) }),
    lane: "one_time",
  },
  // Fetch full content for entries a WebSub push just created, off the hub's
  // callback request. `pending` marks the feed's one not-yet-claimed job, which
  // new entries are appended to — see enqueueFullContentFetch.
  fetch_full_content: {
    payload: z.object({
      feedId: z.string(),
      entryIds: z.array(z.string()),
      pending: z.literal(true).optional(),
    }),
    lane: "full_content",
  },
} as const satisfies Record<string, JobDefinition>;

export type JobType = keyof typeof JOB_DEFINITIONS;

export type JobPayloads = {
  [K in JobType]: z.infer<(typeof JOB_DEFINITIONS)[K]["payload"]>;
};

const ALL_JOB_TYPES = Object.keys(JOB_DEFINITIONS) as JobType[];

/** The job types that declare an `intervalMs`. */
export type FixedIntervalJobType = {
  [K in JobType]: (typeof JOB_DEFINITIONS)[K] extends { intervalMs: number } ? K : never;
}[JobType];

export function isFixedIntervalJobType(type: JobType): type is FixedIntervalJobType {
  const definition: JobDefinition = JOB_DEFINITIONS[type];
  return definition.intervalMs !== undefined;
}

export function getJobIntervalMs(type: FixedIntervalJobType): number {
  return JOB_DEFINITIONS[type].intervalMs;
}

function jobTypesInLanes(...lanes: JobLane[]): JobType[] {
  return ALL_JOB_TYPES.filter((type) => lanes.includes(JOB_DEFINITIONS[type].lane));
}

/** Whether `type` is known to this release (a newer one may enqueue others mid-deploy). */
export function isJobType(type: string): type is JobType {
  return Object.hasOwn(JOB_DEFINITIONS, type);
}

const ONE_TIME_JOB_TYPES = jobTypesInLanes("one_time");

/**
 * How long the worker waits on a handler before freeing its slot. Prevents a
 * hung job (e.g., stuck DB query, pathological XML parsing) from blocking the
 * worker loop forever. The handler itself isn't aborted and may keep running.
 */
export const DEFAULT_JOB_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * How long after its claim a job is assumed to have crashed and can be claimed
 * again. Well above the worker's handler timeout, so only a crashed worker or a
 * handler hung far past that timeout gets a second run — harmless, since every
 * handler is idempotent (#2043).
 */
export const STALE_JOB_THRESHOLD_MS = 20 * 60 * 1000;

/**
 * Base delay before retrying a job whose handler threw: 1 minute.
 */
export const EXCEPTION_RETRY_BASE_MS = 60 * 1000;

/**
 * Maximum delay between retries of a job whose handler keeps throwing: 24 hours.
 */
export const EXCEPTION_RETRY_MAX_MS = 24 * 60 * 60 * 1000;

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
 * Options for finishing a job.
 */
export interface FinishJobOptions {
  success: boolean;
  /** Null for a finished one-time job, which is deleted (see `JobLane`). */
  nextRunAt: Date | null;
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
}

/**
 * Creates a new job in the queue.
 * This should only be called when creating a new scheduled task
 * (e.g., when a feed is first subscribed to).
 *
 * @param options Job creation options
 * @param executor Where to insert it: a transaction makes the job commit with
 *   the change it follows up
 * @returns The created job
 */
export async function createJob<T extends JobType>(
  options: CreateJobOptions<T>,
  executor: DbOrTx = db
): Promise<Job> {
  const { type, payload, nextRunAt = new Date() } = options;

  const id = generateUuidv7();
  const now = new Date();

  const [job] = await executor
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
 * Entries (or prefixes) per storage deletion job (`delete_stored_objects`,
 * `delete_full_content_archives`). Each costs a list request, so this keeps a
 * job well inside {@link DEFAULT_JOB_TIMEOUT_MS} however many entries a delete
 * removes.
 */
export const DELETION_JOB_ENTRIES = 200;

/**
 * Creates a due job of `type` per payload, in one insert.
 *
 * @param executor Where to insert them: a transaction makes the jobs commit
 *   with the change they follow up
 */
export async function createJobs<T extends JobType>(
  type: T,
  payloads: JobPayloads[T][],
  executor: DbOrTx = db
): Promise<void> {
  if (payloads.length === 0) return;
  const now = new Date();
  await executor.insert(jobs).values(
    payloads.map((payload) => ({
      id: generateUuidv7(),
      type,
      payload,
      nextRunAt: now,
      createdAt: now,
      updatedAt: now,
    }))
  );
}

/**
 * Claims the earliest-due one-time job; see {@link claimDueJob}. Feed,
 * singleton and full-content jobs have their own claims.
 *
 * @returns The claimed job, or null if no jobs are available
 */
export async function claimJob(): Promise<Job | null> {
  return claimDueJob(
    () =>
      sql`j.type = ANY(ARRAY[${sql.join(
        ONE_TIME_JOB_TYPES.map((t) => sql`${t}`),
        sql`, `
      )}]::text[])`
  );
}

/**
 * Claims the earliest-due job (alias `j`) matching `eligible`: due, not claimed
 * within {@link STALE_JOB_THRESHOLD_MS}, and not row-locked by a concurrent
 * claim. Stamps `running_since` and returns the job.
 *
 * @param eligible - The caller's extra predicate on `j`, given the claim time
 * @param extraSet - Further `SET` assignments on the claimed row
 */
async function claimDueJob(
  eligible: (claim: { now: Date }) => SQL,
  extraSet: SQL = sql``
): Promise<Job | null> {
  const now = new Date();
  const staleThreshold = new Date(now.getTime() - STALE_JOB_THRESHOLD_MS);

  const result = await db.execute<RawJobRow>(sql`
    UPDATE jobs
    SET
      running_since = ${now},
      updated_at = ${now}
      ${extraSet}
    WHERE id = (
      SELECT j.id FROM jobs j
      WHERE j.next_run_at <= ${now}
        AND (j.running_since IS NULL OR j.running_since < ${staleThreshold})
        AND ${eligible({ now })}
      ORDER BY j.next_run_at ASC
      LIMIT 1
      FOR UPDATE OF j SKIP LOCKED
    )
    RETURNING *
  `);

  return firstJob(result);
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
 * With `nextRunAt: null` (a one-time job that's done), the row is deleted.
 *
 * If the job ran past {@link STALE_JOB_THRESHOLD_MS} and was claimed again, this
 * late finish still applies; it writes a reasonable `next_run_at` either way,
 * and is a no-op if the other run already deleted a one-time job.
 *
 * @param jobId The ID of the job to finish
 * @param options Finish options
 * @returns The updated job, or null if it was or had been deleted
 */
export async function finishJob(jobId: string, options: FinishJobOptions): Promise<Job | null> {
  const { success, nextRunAt, error, consumeForceReprocess } = options;
  if (nextRunAt === null) {
    await db.delete(jobs).where(eq(jobs.id, jobId));
    return null;
  }
  const now = new Date();

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

  const [job] = await db
    .update(jobs)
    .set({
      runningSince: null,
      lastRunAt: now,
      updatedAt: now,
      ...(success
        ? { nextRunAt: nextRunAtExpr, lastError: null, consecutiveFailures: 0, ...payloadUpdate }
        : {
            nextRunAt,
            lastError: error ?? "Unknown error",
            consecutiveFailures: sql`${jobs.consecutiveFailures} + 1`,
          }),
    })
    .where(eq(jobs.id, jobId))
    .returning();

  return job ?? null;
}

/**
 * Validates and returns a job's payload. Throws if the job isn't of `type` or
 * its payload doesn't match the type's schema.
 */
export function getJobPayload<T extends JobType>(job: Job, type: T): JobPayloads[T] {
  if (job.type !== type) {
    throw new Error(`Expected a ${type} job, got ${job.type}`);
  }
  return JOB_DEFINITIONS[type].payload.parse(job.payload) as JobPayloads[T];
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
export async function ensureFeedJob(db: DbOrTx, feedId: string, nextRunAt?: Date): Promise<Job> {
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

  return firstJob(result);
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
export async function scheduleFeedRefreshNow(db: DbOrTx, feedId: string): Promise<Job> {
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
 * Most `fetch_full_content` jobs that may run at once, across all workers.
 *
 * These are created by third-party hub pushes, and each can spend minutes on
 * sequential article fetches against a slow origin. With several worker slots,
 * the cap keeps a push burst from taking all of them. It does nothing on a
 * single-slot worker; there, the claim rotation in `createWorkerClaimJob` is
 * what bounds their share. It's a soft cap — two workers claiming at the same
 * instant can both see room — which is fine for its purpose.
 */
export const MAX_RUNNING_FULL_CONTENT_JOBS = 2;

/**
 * Most entries a feed's pending `fetch_full_content` job holds. A feed that
 * pushes more than this between runs is flooding; the overflow keeps its feed
 * summary rather than growing an unbounded queue of article fetches.
 */
export const MAX_PENDING_FULL_CONTENT_ENTRIES = 50;

/**
 * Queues full-content fetching for a feed's entries, coalesced into the feed's
 * single **pending** (never claimed) `fetch_full_content` job.
 *
 * One pending job per feed is what keeps the queue fair: claims go oldest
 * first, and entries appended to a feed's pending job don't move it forward, so
 * a feed that pushes constantly gets one job's turn at a time instead of a
 * backlog of jobs while other feeds' entries wait. The job processes a batch
 * and re-queues its remainder through this same function, which puts that
 * remainder behind every other feed's pending job.
 *
 * "Pending" is what the partial unique index
 * `idx_jobs_full_content_pending_feed_id` matches: the `pending: true` payload
 * marker, on a row no worker has claimed (`running_since`) or run
 * (`last_run_at`). Keying on the claim columns, not just the marker, means a
 * row leaves the index when any release's worker claims it, so a running or
 * finished job never absorbs new entries.
 *
 * @param options.first - Put these entries ahead of the ones already pending,
 *   so they survive the {@link MAX_PENDING_FULL_CONTENT_ENTRIES} bound. For a
 *   job's re-queued remainder, which is older than anything pushed since.
 */
export async function enqueueFullContentFetch(
  feedId: string,
  entryIds: string[],
  options: { first?: boolean } = {}
): Promise<void> {
  if (entryIds.length === 0) {
    return;
  }
  const now = new Date();
  const payload = {
    feedId,
    entryIds: entryIds.slice(0, MAX_PENDING_FULL_CONTENT_ENTRIES),
    pending: true,
  } satisfies JobPayloads["fetch_full_content"];
  const combined = options.first
    ? sql`(EXCLUDED.payload->'entryIds') || (jobs.payload->'entryIds')`
    : sql`(jobs.payload->'entryIds') || (EXCLUDED.payload->'entryIds')`;

  // On conflict, merge into the pending job's entries: deduplicated, first
  // occurrence order kept, bounded. next_run_at is left alone (see above).
  await db.execute(sql`
    INSERT INTO ${jobs} (id, type, payload, next_run_at, created_at, updated_at)
    VALUES (${generateUuidv7()}, 'fetch_full_content', ${JSON.stringify(payload)}::jsonb, ${now}, ${now}, ${now})
    ON CONFLICT ((payload->>'feedId'))
      WHERE type = 'fetch_full_content'
        AND (payload->>'pending') = 'true'
        AND running_since IS NULL
        AND last_run_at IS NULL
    DO UPDATE SET
      payload = jobs.payload || jsonb_build_object('entryIds', (
        SELECT COALESCE(jsonb_agg(merged.id ORDER BY merged.first_ord), '[]'::jsonb)
        FROM (
          SELECT t.id, min(t.ord) AS first_ord
          FROM jsonb_array_elements_text(${combined}) WITH ORDINALITY AS t(id, ord)
          GROUP BY t.id
          ORDER BY first_ord
          LIMIT ${MAX_PENDING_FULL_CONTENT_ENTRIES}
        ) merged
      )),
      updated_at = ${now}
  `);
}

/**
 * Claims a due `fetch_full_content` job, unless
 * {@link MAX_RUNNING_FULL_CONTENT_JOBS} are already running. Also clears the
 * `pending` marker, which the claim itself already takes the row out of the
 * pending index for (see {@link enqueueFullContentFetch}); it just keeps the
 * payload honest.
 *
 * @returns The claimed job, or null if none is due or the cap is reached
 */
export async function claimFullContentJob(): Promise<Job | null> {
  // A running job is still due (next_run_at is only advanced when it finishes),
  // so bounding the count by next_run_at <= now keeps it on idx_jobs_polling,
  // and the inner LIMIT stops it at the cap. The cap is on worker slots, which
  // free at the job timeout, so an older claim no longer counts.
  return claimDueJob(
    ({ now }) => sql`
      j.type = 'fetch_full_content'
      AND (
        SELECT count(*) FROM (
          SELECT 1 FROM jobs r
          WHERE r.type = 'fetch_full_content'
            AND r.next_run_at <= ${now}
            AND r.running_since >= ${new Date(now.getTime() - DEFAULT_JOB_TIMEOUT_MS)}
          LIMIT ${MAX_RUNNING_FULL_CONTENT_JOBS}
        ) running
      ) < ${MAX_RUNNING_FULL_CONTENT_JOBS}
    `,
    sql`, payload = payload - 'pending'`
  );
}

/**
 * Singleton job types: exactly one row each, created by {@link seedSingletonJobs}.
 *
 * The worker's claim loop tries these first-due-wins, in array order, so a
 * type that reschedules itself near-immediately under backlog would starve
 * every type after it: `reschedulesFast` types go last.
 */
export const SINGLETON_JOB_TYPES: JobType[] = [
  ...jobTypesInLanes("singleton").filter((type) => !isFastRescheduler(type)),
  ...jobTypesInLanes("singleton").filter(isFastRescheduler),
];

function isFastRescheduler(type: JobType): boolean {
  const definition: JobDefinition = JOB_DEFINITIONS[type];
  return definition.reschedulesFast === true;
}

/**
 * Creates the row of every singleton job type that doesn't have one yet, due
 * now. The worker runs this before its first claim; concurrent workers are
 * safe, since `jobs_singleton_type_unique` keeps one row per type. A new
 * singleton type must be added to that index (by migration), or every worker
 * start inserts another row.
 */
export async function seedSingletonJobs(): Promise<void> {
  const now = new Date();
  await db
    .insert(jobs)
    .values(
      SINGLETON_JOB_TYPES.map((type) => ({
        id: generateUuidv7(),
        type,
        payload: {},
        nextRunAt: now,
        createdAt: now,
        updatedAt: now,
      }))
    )
    .onConflictDoNothing();
}

/**
 * Claims a singleton job if it's due. Its row comes from
 * {@link seedSingletonJobs}.
 *
 * @param type - The singleton job type to claim
 * @returns The claimed job, or null if not due or already running
 */
export async function claimSingletonJob(type: JobType): Promise<Job | null> {
  if (!SINGLETON_JOB_TYPES.includes(type)) {
    throw new Error(`${type} is not a singleton job type`);
  }
  return claimDueJob(() => sql`j.type = ${type}`);
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
  // EXISTS rather than JOIN + GROUP BY, which FOR UPDATE can't lock through.
  return claimDueJob(
    () => sql`
      j.type = 'fetch_feed'
      AND EXISTS (
        SELECT 1 FROM subscriptions s
        WHERE s.feed_id = (j.payload->>'feedId')::uuid
          AND s.unsubscribed_at IS NULL
      )
    `
  );
}

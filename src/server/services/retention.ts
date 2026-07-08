/**
 * Retention cleanup for rows that expire but were never deleted (issue #953).
 *
 * Run by the `cleanup` singleton job once a day. Every row deleted here is
 * already dead to the application — expired/revoked credentials all fail
 * validation on their read paths, parked one-time jobs never run again, and
 * subscriber-less `fetch_feed` jobs are permanently ineligible for claiming
 * (issue #1085) — so deletion only reclaims space and index bloat (and, for
 * dead feed jobs, un-drags the claim scan), never changes behavior.
 */

import { and, eq, gt, isNull, lt, notExists, or, sql } from "drizzle-orm";
import type { Database } from "../db";
import {
  jobs,
  oauthAccessTokens,
  oauthAuthorizationCodes,
  oauthClients,
  oauthConsentGrants,
  oauthRefreshTokens,
  sessions,
} from "../db/schema";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Grace period after expiry before a row is deleted. Generous slack for clock
 * skew and in-flight requests; these rows already fail validation everywhere.
 */
const EXPIRY_GRACE_MS = DAY_MS;

/**
 * How long revoked sessions and refresh tokens are retained after revocation.
 * Revoked refresh tokens are kept for a while so rotation reuse-detection
 * (spotting a stolen token being replayed) still has something to match.
 */
const REVOKED_RETENTION_MS = 30 * DAY_MS;

/**
 * One-time jobs are "parked" after completion by scheduling them far in the
 * future (365 days; see handleProcessOpmlImport). Anything scheduled further
 * out than this threshold is such a parked job and can be deleted.
 */
const PARKED_JOB_THRESHOLD_MS = 180 * DAY_MS;

/**
 * Grace period before a subscriber-less `fetch_feed` job is deleted (issue #1085).
 *
 * `createSubscription` calls `ensureFeedJob` (committing the job row) *before*
 * committing the subscription row, so for the very first subscriber to a feed
 * there is a brief window where the job exists but no active subscription is yet
 * visible. Requiring the job to be at least this old avoids racing that window;
 * a genuinely dead job (feed unsubscribed / user deleted) has an old `created_at`
 * — `ensureFeedJob`'s upsert never touches `created_at` — so it is unaffected.
 */
const DEAD_FEED_JOB_GRACE_MS = 60 * 60 * 1000;

/**
 * How long an orphaned Dynamic Client Registration (RFC 7591) client is retained
 * before deletion. `/oauth/register` is open (no auth) and MCP clients such as
 * claude.ai re-register on every connect, so most rows never complete an
 * authorization; without cleanup they accumulate unbounded. A registration older
 * than this with no live tokens and no active consent grant is dead — the client
 * would have to re-register to be usable — so it's safe to remove. Kept generous
 * so a client mid-onboarding (registered, not yet authorized) isn't reaped.
 */
const ORPHANED_CLIENT_RETENTION_MS = 30 * DAY_MS;

/**
 * Row counts deleted by a cleanup run, keyed for job metadata/logging.
 */
export interface RetentionCleanupResult {
  sessions: number;
  oauthAuthorizationCodes: number;
  oauthAccessTokens: number;
  oauthRefreshTokens: number;
  oauthClients: number;
  parkedJobs: number;
  deadFeedJobs: number;
}

/**
 * Deletes expired/revoked credentials, orphaned DCR clients, and parked
 * one-time jobs.
 */
export async function runRetentionCleanup(db: Database): Promise<RetentionCleanupResult> {
  const now = Date.now();
  const nowDate = new Date(now);
  const expiryCutoff = new Date(now - EXPIRY_GRACE_MS);
  const revokedCutoff = new Date(now - REVOKED_RETENTION_MS);
  const parkedCutoff = new Date(now + PARKED_JOB_THRESHOLD_MS);
  const deadFeedJobCutoff = new Date(now - DEAD_FEED_JOB_GRACE_MS);
  const orphanedClientCutoff = new Date(now - ORPHANED_CLIENT_RETENTION_MS);

  const expiredSessions = await db
    .delete(sessions)
    .where(or(lt(sessions.expiresAt, expiryCutoff), lt(sessions.revokedAt, revokedCutoff)));

  const expiredAuthCodes = await db
    .delete(oauthAuthorizationCodes)
    .where(lt(oauthAuthorizationCodes.expiresAt, expiryCutoff));

  // Refresh tokens reference access tokens with ON DELETE SET NULL, and the
  // rotation chain (replaced_by_id) is also SET NULL, so bulk deletes can't
  // fail on FK order.
  const expiredAccessTokens = await db
    .delete(oauthAccessTokens)
    .where(
      or(
        lt(oauthAccessTokens.expiresAt, expiryCutoff),
        lt(oauthAccessTokens.revokedAt, revokedCutoff)
      )
    );

  const expiredRefreshTokens = await db
    .delete(oauthRefreshTokens)
    .where(
      or(
        lt(oauthRefreshTokens.expiresAt, expiryCutoff),
        lt(oauthRefreshTokens.revokedAt, revokedCutoff)
      )
    );

  // Completed one-time jobs park themselves by scheduling next_run_at a year
  // out. running_since IS NULL guards against deleting anything in flight.
  const parkedJobs = await db
    .delete(jobs)
    .where(
      and(
        eq(jobs.type, "process_opml_import"),
        isNull(jobs.runningSince),
        gt(jobs.nextRunAt, parkedCutoff)
      )
    );

  // Dead feed jobs (issue #1085): a `fetch_feed` job survives when its feed
  // loses its last active subscriber (unsubscribe soft-delete) or the feed is
  // hard-deleted (deleteUser orphan cleanup — jobs have no FK to feeds). Such a
  // job is permanently ineligible for `claimFeedJob` (its active-subscriber
  // EXISTS check fails) yet its `next_run_at` stays frozen in the past, so it
  // sorts *first* and is walked on every claim attempt — including every idle
  // poll — dragging the claim scan forever. Deleting it is safe: a new
  // subscriber recreates the job via `ensureFeedJob`'s idempotent upsert. Guard
  // with `running_since IS NULL` (never touch an in-flight job) and a grace on
  // `created_at` (see DEAD_FEED_JOB_GRACE_MS) so we don't race the first-ever
  // subscribe, where the job is committed just before its subscription.
  //
  // The `running_since IS NULL` guard is deliberately stricter than
  // `claimFeedJob`'s staleness check (`running_since IS NULL OR ... < staleThreshold`):
  // we'd rather leave a rare crashed-mid-fetch job (stale `running_since`) in
  // place than risk deleting a genuinely in-flight one. Such a job is reclaimed
  // by `claimFeedJob`'s stale path and becomes deletable on a later sweep.
  const deadFeedJobs = await db.execute(sql`
    DELETE FROM ${jobs} j
    WHERE j.type = 'fetch_feed'
      AND j.running_since IS NULL
      AND j.created_at < ${deadFeedJobCutoff}
      AND NOT EXISTS (
        SELECT 1 FROM subscriptions s
        WHERE s.feed_id = (j.payload->>'feedId')::uuid
          AND s.unsubscribed_at IS NULL
      )
  `);

  // Orphaned Dynamic Client Registration clients (issue #975): every row in
  // oauth_clients comes from open /oauth/register (CIMD URL clients are resolved
  // on the fly and never stored). Delete old registrations that never became
  // usable — no live (non-revoked, unexpired) access or refresh token and no
  // active consent grant. clientId is a plain text column (no FK), so an active
  // client is protected by these NOT EXISTS checks, not by referential integrity;
  // the liveness predicates match resolveClient/token validation exactly so we
  // never remove a client a future request could still authenticate against.
  const orphanedClients = await db.delete(oauthClients).where(
    and(
      lt(oauthClients.createdAt, orphanedClientCutoff),
      notExists(
        db
          .select({ one: sql`1` })
          .from(oauthAccessTokens)
          .where(
            and(
              eq(oauthAccessTokens.clientId, oauthClients.clientId),
              isNull(oauthAccessTokens.revokedAt),
              gt(oauthAccessTokens.expiresAt, nowDate)
            )
          )
      ),
      notExists(
        db
          .select({ one: sql`1` })
          .from(oauthRefreshTokens)
          .where(
            and(
              eq(oauthRefreshTokens.clientId, oauthClients.clientId),
              isNull(oauthRefreshTokens.revokedAt),
              gt(oauthRefreshTokens.expiresAt, nowDate)
            )
          )
      ),
      notExists(
        db
          .select({ one: sql`1` })
          .from(oauthConsentGrants)
          .where(
            and(
              eq(oauthConsentGrants.clientId, oauthClients.clientId),
              isNull(oauthConsentGrants.revokedAt)
            )
          )
      )
    )
  );

  return {
    sessions: expiredSessions.rowCount ?? 0,
    oauthAuthorizationCodes: expiredAuthCodes.rowCount ?? 0,
    oauthAccessTokens: expiredAccessTokens.rowCount ?? 0,
    oauthRefreshTokens: expiredRefreshTokens.rowCount ?? 0,
    oauthClients: orphanedClients.rowCount ?? 0,
    parkedJobs: parkedJobs.rowCount ?? 0,
    deadFeedJobs: deadFeedJobs.rowCount ?? 0,
  };
}

/**
 * Handler for `fetch_full_content` jobs.
 *
 * A WebSub push is ingested inside the hub's callback request, which must not
 * wait on slow article fetches, so the push enqueues this job for the entries it
 * created instead. See `fetchFullContentForNewEntries` in
 * src/server/services/full-content.ts for the work itself.
 */

import { db } from "../../db";
import { fetchFullContentForNewEntries } from "../../services/full-content";
import { ONE_TIME_JOB_PARK_MS, type JobPayloads } from "../queue";
import type { JobHandlerResult } from "./types";

/**
 * How many times a job may throw before it gives up. Per-entry fetch failures
 * don't throw (they're recorded on the entry), so a throw means infrastructure
 * trouble; a few backed-off retries (1m, 2m) ride out a blip, and past that the
 * summary the feed already provided is an acceptable fallback.
 */
const MAX_ATTEMPTS = 3;

/**
 * Fetches full content for the pushed entries, then parks the job. A retry
 * redoes only the entries that don't have a result yet — the helper skips any
 * with one — so work finished before a failure isn't repeated.
 *
 * @param consecutiveFailures - How many earlier attempts threw (the job row's
 *   `consecutive_failures` as claimed)
 */
export async function handleFetchFullContent(
  payload: JobPayloads["fetch_full_content"],
  consecutiveFailures: number
): Promise<JobHandlerResult> {
  // A one-time job: park it whatever the outcome (see ONE_TIME_JOB_TYPES).
  const parkedUntil = new Date(Date.now() + ONE_TIME_JOB_PARK_MS);

  if (consecutiveFailures >= MAX_ATTEMPTS) {
    return {
      success: false,
      nextRunAt: parkedUntil,
      error: `Giving up after ${consecutiveFailures} failed attempts`,
    };
  }

  const { fetched, failed } = await fetchFullContentForNewEntries(
    db,
    payload.feedId,
    payload.entryIds
  );

  return {
    success: true,
    nextRunAt: parkedUntil,
    metadata: { feedId: payload.feedId, fullContentFetched: fetched, fullContentFailed: failed },
  };
}

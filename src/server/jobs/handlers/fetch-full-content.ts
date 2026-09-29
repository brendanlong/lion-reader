/**
 * Handler for `fetch_full_content` jobs.
 *
 * A WebSub push is ingested inside the hub's callback request, which must not
 * wait on slow article fetches, so the push queues the entries it created on
 * the feed's pending job instead (`enqueueFullContentFetch`). See
 * `fetchFullContentForNewEntries` in src/server/services/full-content.ts for the
 * work itself.
 */

import { db } from "../../db";
import {
  fetchFullContentForNewEntries,
  MAX_FULL_CONTENT_ENTRIES_PER_BATCH,
} from "../../services/full-content";
import { enqueueFullContentFetch, ONE_TIME_JOB_PARK_MS, type JobPayloads } from "../queue";
import type { JobHandlerResult } from "./types";

/**
 * Attempts before a job gives up. Per-entry fetch failures don't throw (they're
 * recorded on the entry), so a throw means infrastructure trouble; the worker's
 * backed-off retries (1 min, then 2 min) ride out a blip, and past that the
 * summary the feed already provided is an acceptable fallback.
 */
const MAX_ATTEMPTS = 3;

/**
 * Fetches full content for one batch of the job's entries, re-queues the rest
 * behind other feeds' pending jobs, and parks the job.
 *
 * A retry redoes only the entries without a result yet — the helper skips any
 * that have one — so work finished before a failure isn't repeated.
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
  const batch = payload.entryIds.slice(0, MAX_FULL_CONTENT_ENTRIES_PER_BATCH);
  const rest = payload.entryIds.slice(MAX_FULL_CONTENT_ENTRIES_PER_BATCH);

  let result: { fetched: number; failed: number };
  try {
    result = await fetchFullContentForNewEntries(db, payload.feedId, batch);
    // After the batch, not before, so a feed's next batch waits its turn behind
    // other feeds instead of running alongside this one against the same origin.
    await enqueueFullContentFetch(payload.feedId, rest);
  } catch (error) {
    if (consecutiveFailures + 1 < MAX_ATTEMPTS) {
      throw error; // The worker retries with backoff.
    }
    return {
      success: false,
      nextRunAt: parkedUntil,
      error: `Giving up after ${MAX_ATTEMPTS} attempts: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  return {
    success: true,
    nextRunAt: parkedUntil,
    metadata: {
      feedId: payload.feedId,
      fullContentFetched: result.fetched,
      fullContentFailed: result.failed,
      requeuedEntries: rest.length,
    },
  };
}

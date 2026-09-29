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
 * Fetches full content for the pushed entries. Per-entry fetch failures are
 * persisted on the entry and don't fail the job; only an infrastructure error
 * (thrown) does, which the worker retries with backoff.
 */
export async function handleFetchFullContent(
  payload: JobPayloads["fetch_full_content"]
): Promise<JobHandlerResult> {
  const { fetched, failed } = await fetchFullContentForNewEntries(
    db,
    payload.feedId,
    payload.entryIds
  );

  return {
    success: true,
    // A one-time job: park it (see ONE_TIME_JOB_TYPES).
    nextRunAt: new Date(Date.now() + ONE_TIME_JOB_PARK_MS),
    metadata: { feedId: payload.feedId, fullContentFetched: fetched, fullContentFailed: failed },
  };
}

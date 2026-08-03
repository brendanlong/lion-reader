/**
 * Handler for `backfill_getting_started` jobs (singleton).
 *
 * See src/server/services/getting-started.ts for the backfill itself.
 */

import { db } from "../../db";
import { backfillGettingStartedArticles } from "../../services/getting-started";
import type { JobPayloads } from "../queue";
import type { JobHandlerResult } from "./types";

/** Users given a Getting Started article per backfill run. */
const GETTING_STARTED_BATCH_SIZE = 100;

/** Gap between backfill runs while users are still waiting. */
const GETTING_STARTED_BACKLOG_INTERVAL_MS = 15 * 1000;

/**
 * Gap once the backlog is drained. The job stays alive rather than parking:
 * the same scan also catches anyone whose signup-path insert failed, and once
 * the partial index is empty the query costs nothing.
 */
const GETTING_STARTED_IDLE_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Handler for backfill_getting_started jobs (singleton, stateless).
 * See src/server/services/getting-started.ts.
 */
export async function handleBackfillGettingStarted(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _payload: JobPayloads["backfill_getting_started"]
): Promise<JobHandlerResult> {
  const result = await backfillGettingStartedArticles(db, GETTING_STARTED_BATCH_SIZE);

  // Come back promptly while we're filling batches and getting somewhere. A
  // batch where *nothing* succeeded drops to the idle cadence rather than
  // spinning every 15 seconds; a batch with a few stuck users still counts as
  // progress, so one poison row can't throttle the whole backfill to daily.
  const moreLikely = result.attempted === GETTING_STARTED_BATCH_SIZE && result.created > 0;

  return {
    success: true,
    nextRunAt: new Date(
      Date.now() +
        (moreLikely ? GETTING_STARTED_BACKLOG_INTERVAL_MS : GETTING_STARTED_IDLE_INTERVAL_MS)
    ),
    metadata: { ...result },
  };
}

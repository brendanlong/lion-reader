/**
 * Feeds Service
 *
 * Operations on shared feed rows. Callers check the user may act on the feed.
 */

import { eq, sql } from "drizzle-orm";
import type { DbOrTx } from "@/server/db";
import { feeds, jobs } from "@/server/db/schema";

/** Clears a feed's failure backoff and makes its fetch job due now. */
export async function retryFeed(db: DbOrTx, feedId: string): Promise<void> {
  const now = new Date();
  await db
    .update(feeds)
    .set({ consecutiveFailures: 0, lastError: null, nextFetchAt: now, updatedAt: now })
    .where(eq(feeds.id, feedId));
  await db
    .update(jobs)
    .set({ consecutiveFailures: 0, lastError: null, nextRunAt: now, updatedAt: now })
    .where(sql`${jobs.payload}->>'feedId' = ${feedId} AND ${jobs.type} = 'fetch_feed'`);
}

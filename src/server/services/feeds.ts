/**
 * Feeds Service
 *
 * Operations on shared feed rows. Callers check the user may act on the feed.
 */

import { and, eq, isNull, sql } from "drizzle-orm";
import type { DbOrTx } from "@/server/db";
import { feeds, jobs, subscriptions } from "@/server/db/schema";
import { errors } from "@/server/errors";
import { consumePlanQuota } from "@/server/services/plans";

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

/**
 * A user's retry of the feed behind one of their active subscriptions, which
 * takes one of their page fetches.
 */
export async function retrySubscriptionFeed(
  db: DbOrTx,
  userId: string,
  subscriptionId: string
): Promise<void> {
  const [subscription] = await db
    .select({ feedId: subscriptions.feedId })
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.id, subscriptionId),
        eq(subscriptions.userId, userId),
        isNull(subscriptions.unsubscribedAt)
      )
    )
    .limit(1);

  // A subscription without a feed (#1846) has nothing to fetch.
  const feedId = subscription?.feedId;
  if (!feedId) {
    throw errors.subscriptionNotFound();
  }

  await consumePlanQuota(db, userId, "pageFetches");
  await retryFeed(db, feedId);
}

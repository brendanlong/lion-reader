/**
 * Shared processing for WebSub content notifications (the POST body a hub pushes
 * when a feed updates).
 */

import { eq } from "drizzle-orm";
import { db } from "../db";
import { databaseNow } from "../db/temporal";
import { feeds, type Feed } from "../db/schema";
import { parseFeedAsync } from "./parser";
import { countEntryWrites, processEntries } from "./entry-processor";
import { recordHubAnnouncedEntries, recordHubRateLimitedEntries } from "./websub-hub-stats";
import { MIN_FETCH_INTERVAL_SECONDS } from "./scheduling";
import { enqueueFullContentFetch, scheduleFeedJobBy } from "../jobs/queue";
import { checkRateLimit } from "../rate-limit";
import { getFeedPlugin } from "../plugins";
import { feedWantsFullContent } from "../services/full-content";
import { trackWebsubNotificationReceived } from "../metrics/metrics";
import { logger } from "@/lib/logger";

/**
 * Result of ingesting a pushed notification, so the callback route can pick a
 * status code: only `failed` asks the hub to retry.
 */
export type WebsubIngestOutcome =
  /** Entries were processed (or there were none). */
  | "processed"
  /** The body wasn't a parseable feed. Nothing to do; a retry can't help. */
  | "unparseable"
  /**
   * The feed is over its push budget, so nothing was ingested and a poll was
   * scheduled instead. A retry would be dropped too.
   */
  | "rate_limited"
  /** Infrastructure failure (DB down, etc.). The push is lost unless the hub retries. */
  | "failed";

/**
 * Handles a push over the feed's budget: records the dropped writes and
 * schedules a poll to pick up whatever the feed still lists, so legitimate
 * entries arrive late rather than never. The poll runs no sooner than the
 * minimum poll interval after the last one, so pushes can't make us poll faster
 * than an ordinary feed is polled. A failing feed keeps its backoff: its next
 * poll is already scheduled, and `Retry-After` must stay a floor.
 */
async function dropOverBudgetPush(feed: Feed, writeCount: number): Promise<void> {
  const feedId = feed.id;
  logger.warn("WebSub push over the feed's budget; dropped it", {
    feedId,
    hubUrl: feed.hubUrl,
    entryWrites: writeCount,
  });
  if (feed.hubUrl) {
    await recordHubRateLimitedEntries(feed.hubUrl, writeCount);
  }
  if (feed.consecutiveFailures > 0) {
    return;
  }

  const minIntervalSeconds = Math.max(
    MIN_FETCH_INTERVAL_SECONDS,
    getFeedPlugin(feed.url)?.capabilities.feed.minFetchIntervalSeconds ?? 0
  );
  const pollAt = new Date(
    Math.max(Date.now(), (feed.lastFetchedAt?.getTime() ?? 0) + minIntervalSeconds * 1000)
  );
  await scheduleFeedJobBy(feedId, pollAt);
}

/**
 * Queues full-content fetching for the entries a push just created, if a
 * subscriber wants it and their plan includes it (`feedWantsFullContent`) — the same work a poll does inline for its new entries
 * (`fetchFullContentForNewEntries`). A push is ingested inside the hub's
 * callback request, so the slow article fetches go to the feed's pending
 * `fetch_full_content` job (see `enqueueFullContentFetch`) rather than holding
 * the response open.
 *
 * Failure is logged, not propagated: the entries are already committed, so
 * answering 503 wouldn't help — a redelivered push finds them unchanged and
 * queues nothing.
 */
async function queueFullContentFetch(feedId: string, entryIds: string[]): Promise<void> {
  if (entryIds.length === 0) {
    return;
  }
  try {
    if (!(await feedWantsFullContent(db, feedId))) {
      return;
    }
    await enqueueFullContentFetch(feedId, entryIds);
  } catch (error) {
    logger.warn("Failed to queue full-content fetch for WebSub entries", {
      feedId,
      entryCount: entryIds.length,
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
}

/**
 * Parses a pushed WebSub notification body and processes its entries into the
 * given feed. A push never defers the feed's poll: a websub-active feed's polls
 * already schedule themselves on the backup interval, and the poll is what
 * confirms or drops pushed entries for new subscribers (`currentEntryIdsSql`).
 *
 * Never throws; it reports what happened instead, because the two failure modes
 * want opposite answers to the hub. An unparseable body is final — a redelivery
 * of the same bytes would fail identically — so the route acknowledges it. A
 * failure *processing* a parsed feed is infrastructure (`processEntries` handles
 * per-entry errors internally), and swallowing it loses the pushed entry for
 * good: the hub records a successful delivery and never retries. So the route
 * answers 503 on that path and lets the hub redeliver, which is safe because
 * ingest is idempotent (entries match on `content_hash`).
 *
 * A push is charged the entries it would create or change against the feed's
 * budget (`websubPush` rate limit); one over budget is dropped and acknowledged, since a redelivery would be dropped too;
 * see `dropOverBudgetPush`.
 *
 * The caller is responsible for authenticating the notification (HMAC) and
 * loading the feed before calling this.
 */
export async function ingestWebsubNotification(
  feed: Feed,
  bodyText: string
): Promise<WebsubIngestOutcome> {
  const feedId = feed.id;
  trackWebsubNotificationReceived();

  // Parse the pushed feed content
  let parsedFeed;
  try {
    parsedFeed = await parseFeedAsync(bodyText);
  } catch (error) {
    logger.warn("WebSub notification with invalid feed content", {
      feedId,
      error: error instanceof Error ? error.message : "Unknown error",
    });
    // Nothing to process; don't schedule a backup poll off garbage content.
    return "unparseable";
  }

  try {
    const writeCount = await countEntryWrites(db, feedId, parsedFeed);
    if (writeCount > 0) {
      const budget = await checkRateLimit(`feed:${feedId}`, "websubPush", { cost: writeCount });
      if (!budget.allowed) {
        await dropOverBudgetPush(feed, writeCount);
        return "rate_limited";
      }
    }

    // The database clock: the entries' pushed_at is compared with the poll's
    // last_fetched_at (`currentEntryIdsSql`).
    const now = new Date((await databaseNow(db)).epochMilliseconds);
    const result = await processEntries(db, feedId, parsedFeed, {
      fetchedAt: now,
      pushed: true,
      // A push never advances last_fetched_at, so this stays the last full poll:
      // anything the hub announces that predates it by a wide margin is the
      // publisher replaying its archive, not news (issue #1500).
      previousLastFetchedAt: feed.lastFetchedAt,
      feedUrl: feed.url ?? undefined,
      // Matches the feeds.title update below so new_entry events carry the
      // same title a later entries.list refetch would return.
      feedTitle: parsedFeed.title || feed.title,
    });

    // Refresh feed metadata, but none of the poll state: `last_fetched_at`,
    // `last_entries_updated_at` and `body_hash` describe the last poll, and
    // which entries are current, subscribe-time staleness and feed-health
    // monitoring key off them.
    await db
      .update(feeds)
      .set({
        updatedAt: now,
        title: parsedFeed.title || feed.title,
        description: parsedFeed.description || feed.description,
        siteUrl: parsedFeed.siteUrl || feed.siteUrl,
      })
      .where(eq(feeds.id, feedId));

    logger.info("WebSub notification processed", {
      feedId,
      newEntries: result.newCount,
      updatedEntries: result.updatedCount,
      unchangedEntries: result.unchangedCount,
      backfilledEntries: result.backfillCount,
    });

    // Credit the hub for any new entries it pushed, so we can later compare this
    // against entries the backup poll had to discover (see websub-hub-stats.ts).
    // Backfill doesn't count: the tally is about how *new articles* first reach
    // us, and an archive replay isn't one.
    const announcedCount = result.newCount - result.backfillCount;
    if (announcedCount > 0 && feed.hubUrl) {
      await recordHubAnnouncedEntries(feed.hubUrl, announcedCount);
    }

    // What the push announced, as on the poll path.
    await queueFullContentFetch(feedId, result.announcedEntryIds);
  } catch (error) {
    logger.error("WebSub notification processing failed", {
      feedId,
      error: error instanceof Error ? error.message : "Unknown error",
    });
    return "failed";
  }

  return "processed";
}

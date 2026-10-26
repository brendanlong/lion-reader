/**
 * Shared processing for WebSub content notifications (the POST body a hub pushes
 * when a feed updates).
 */

import { eq } from "drizzle-orm";
import { db } from "../db";
import { databaseNow } from "../db/temporal";
import { feeds, type Feed } from "../db/schema";
import { parseFeedAsync } from "./parser";
import { processEntries } from "./entry-processor";
import { recordHubAnnouncedEntries } from "./websub-hub-stats";
import { WEBSUB_BACKUP_POLL_INTERVAL_SECONDS } from "./scheduling";
import { enqueueFullContentFetch, updateFeedJobNextRun } from "../jobs/queue";
import { feedWantsFullContent } from "../services/full-content";
import { trackWebsubNotificationReceived } from "../metrics/metrics";
import { logger } from "@/lib/logger";

/**
 * Result of ingesting a pushed notification, so the callback route can pick a
 * status code: only `failed` asks the hub to retry.
 */
export type WebsubIngestOutcome =
  /** Entries were processed (or there were none) and the backup poll rescheduled. */
  | "processed"
  /** The body wasn't a parseable feed. Nothing to do; a retry can't help. */
  | "unparseable"
  /** Infrastructure failure (DB down, etc.). The push is lost unless the hub retries. */
  | "failed";

/**
 * Pushes the feed's backup poll out, so a push-active feed isn't polled on the
 * ordinary cadence — but never past `WEBSUB_BACKUP_POLL_INTERVAL_SECONDS` after
 * the last **real** poll.
 *
 * A push doesn't advance `feeds.last_fetched_at` (see `ingestWebsubNotification`),
 * so deferring to "now + 24h" on every push starves the backup poll of any feed
 * whose hub pushes more often than daily: the poll is deferred again before it
 * ever runs, and it never runs. That poll is load-bearing — it is what confirms
 * or drops pushed entries for new subscribers (`currentEntryIdsSql`), and the only
 * way a push miss gets tallied — so bound the deferral by the last real poll
 * instead of by "now".
 *
 * A feed with no successful poll yet has no bound to compute, and its first poll
 * is what establishes one: leave its job alone rather than deferring it a day.
 */
async function scheduleBackupPoll(feed: Feed): Promise<void> {
  const feedId = feed.id;
  const intervalMs = WEBSUB_BACKUP_POLL_INTERVAL_SECONDS * 1000;
  const lastFetchedAt = feed.lastFetchedAt;

  if (!lastFetchedAt) {
    logger.debug("Skipping WebSub backup poll deferral for a never-fetched feed", { feedId });
    return;
  }

  const nextRunAt = new Date(
    Math.min(Date.now() + intervalMs, lastFetchedAt.getTime() + intervalMs)
  );

  try {
    await updateFeedJobNextRun(feedId, nextRunAt);
    logger.debug("Scheduled WebSub backup poll", {
      feedId,
      nextRunAt: nextRunAt.toISOString(),
    });
  } catch (error) {
    // Don't let scheduling errors affect the response
    logger.warn("Failed to schedule WebSub backup poll", {
      feedId,
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
}

/**
 * Queues full-content fetching for the entries a push just created, if any
 * subscriber wants it — the same work a poll does inline for its new entries
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
 * given feed, then schedules a backup poll.
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
    // Don't defer the backup poll: nothing was ingested, so the feed still needs
    // a real poll, and pushing it a day out would delay recovery by that long.
    return "failed";
  }

  await scheduleBackupPoll(feed);
  return "processed";
}

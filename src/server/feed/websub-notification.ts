/**
 * Shared processing for WebSub content notifications (the POST body a hub pushes
 * when a feed updates). Used by both the per-subscription callback route and the
 * legacy per-feed callback route so the ingest path stays in one place.
 */

import { eq } from "drizzle-orm";
import { db } from "../db";
import { feeds, type Feed } from "../db/schema";
import { parseFeedInWorker } from "../worker-thread/pool";
import { processEntries } from "./entry-processor";
import { recordHubAnnouncedEntries } from "./websub-hub-stats";
import { WEBSUB_BACKUP_POLL_INTERVAL_SECONDS } from "./scheduling";
import { updateFeedJobNextRun } from "../jobs/queue";
import { trackWebsubNotificationReceived } from "../metrics/metrics";
import { logger } from "@/lib/logger";

/**
 * Schedules a backup polling job for a feed after a WebSub notification.
 * Uses a longer interval than normal since WebSub is active, so we still get
 * updates if WebSub stops working. Updates the existing job's next_run_at.
 */
async function scheduleBackupPoll(feedId: string): Promise<void> {
  const nextRunAt = new Date(Date.now() + WEBSUB_BACKUP_POLL_INTERVAL_SECONDS * 1000);

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
 * Parses a pushed WebSub notification body and processes its entries into the
 * given feed, then schedules a backup poll. Best-effort: never throws, so the
 * route can always acknowledge the hub with 200 (a retry wouldn't help — we
 * already have the content, or it was unparseable).
 *
 * The caller is responsible for authenticating the notification (HMAC) and
 * loading the feed before calling this.
 */
export async function ingestWebsubNotification(feed: Feed, bodyText: string): Promise<void> {
  const feedId = feed.id;
  trackWebsubNotificationReceived();

  // Parse the pushed feed content
  let parsedFeed;
  try {
    parsedFeed = await parseFeedInWorker(bodyText);
  } catch (error) {
    logger.warn("WebSub notification with invalid feed content", {
      feedId,
      error: error instanceof Error ? error.message : "Unknown error",
    });
    // Nothing to process; don't schedule a backup poll off garbage content.
    return;
  }

  const now = new Date();
  try {
    const result = await processEntries(feedId, feed.type, parsedFeed, {
      fetchedAt: now,
      feedUrl: feed.url ?? undefined,
      // Matches the feeds.title update below so new_entry events carry the
      // same title a later entries.list refetch would return.
      feedTitle: parsedFeed.title || feed.title,
      // WebSub ingest runs in the Next.js app process on the request path, so
      // offload large-body sanitization to the worker pool (CLAUDE.md). The feed
      // worker's own polling path keeps the default synchronous sanitize.
      offloadSanitize: true,
    });

    // Update feed timestamps and any refreshed metadata
    await db
      .update(feeds)
      .set({
        lastFetchedAt: now,
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
    });

    // Credit the hub for any new entries it pushed, so we can later compare this
    // against entries the backup poll had to discover (see websub-hub-stats.ts).
    if (result.newCount > 0 && feed.hubUrl) {
      await recordHubAnnouncedEntries(feed.hubUrl, result.newCount);
    }
  } catch (error) {
    logger.error("WebSub notification processing failed", {
      feedId,
      error: error instanceof Error ? error.message : "Unknown error",
    });
    // Fall through to schedule the backup poll so the feed still refreshes.
  }

  await scheduleBackupPoll(feedId);
}

/**
 * Detection and reporting for the two ways a feed can quietly hand us content
 * we didn't expect (issue #1500):
 *
 * - **Truncation**: the publisher served more entries than `MAX_FEED_ENTRIES`,
 *   so we discarded some. Whichever entries lose, content is being dropped on
 *   the floor, and a feed that suddenly serves its whole archive shows up here
 *   first.
 * - **Backfill**: a feed we have polled before introduced entries published long
 *   before that previous poll. Those land in every subscriber's unread list even
 *   though they are years old.
 *
 * Neither is necessarily a bug on our side — a publisher raising their feed
 * length, re-issuing guids after a platform migration, or serving an archive
 * page all produce them — but both are invisible without this, which is what
 * made #1500 undiagnosable after the fact. Report them as warnings (with the
 * feed context needed to investigate) plus Prometheus counters that survive log
 * retention.
 */

import type { ParsedFeed } from "./types";
import type { ProcessEntriesResult } from "./entry-processor";
import {
  trackFeedBackfilledEntries,
  trackFeedEntriesDropped,
  type FeedIngestSource,
} from "../metrics/metrics";
import { logger } from "@/lib/logger";

/**
 * How far before the previous fetch an entry's publication date has to sit
 * before we call it a backfill rather than ordinary publishing lag.
 *
 * A feed we already poll should only ever introduce entries published since the
 * last poll, but plenty of publishers backdate slightly (editorial pipelines,
 * timezone-less dates, an item added a few days late), and a feed coming back
 * from an outage legitimately carries entries older than its last successful
 * fetch. A week of slack keeps those quiet while still catching the case that
 * matters: an archive dump of articles months or years old.
 */
export const BACKFILL_AGE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * What a single ingest (poll or push) did that is worth reporting.
 */
export interface FeedIngestAnomalies {
  /** Entries the publisher served that the `MAX_FEED_ENTRIES` limit discarded. */
  droppedItemCount: number;
  /** New entries published more than {@link BACKFILL_AGE_THRESHOLD_MS} before the previous fetch. */
  backfilledCount: number;
  /** Oldest publication date among the backfilled entries, if any. */
  oldestBackfilledPublishedAt: Date | null;
  /** Newest publication date among the backfilled entries, if any. */
  newestBackfilledPublishedAt: Date | null;
}

/**
 * Classifies one ingest. Pure — no logging, no metrics, no I/O.
 *
 * @param parsedFeed - The parsed feed, whose `totalItemCount` reveals truncation
 * @param processed - The result of storing that feed's entries
 * @param previousFetchAt - `feeds.last_fetched_at` from *before* this ingest, or
 *   null if we have never fetched this feed. Backfill is meaningless on a first
 *   fetch (every entry is legitimately older than us), so it reports zero.
 * @returns The anomalies found; all-zero when the ingest was unremarkable
 */
export function detectFeedIngestAnomalies(
  parsedFeed: ParsedFeed,
  processed: ProcessEntriesResult,
  previousFetchAt: Date | null
): FeedIngestAnomalies {
  const droppedItemCount = Math.max(
    0,
    (parsedFeed.totalItemCount ?? parsedFeed.items.length) - parsedFeed.items.length
  );

  const anomalies: FeedIngestAnomalies = {
    droppedItemCount,
    backfilledCount: 0,
    oldestBackfilledPublishedAt: null,
    newestBackfilledPublishedAt: null,
  };

  if (!previousFetchAt) {
    return anomalies;
  }

  const cutoff = previousFetchAt.getTime() - BACKFILL_AGE_THRESHOLD_MS;

  for (const entry of processed.entries) {
    // Only newly-created entries matter: re-seeing an old entry we already store
    // is normal, and an update never changes published_at.
    const publishedAt = entry.isNew ? entry.newEntryData?.publishedAt : null;
    if (!publishedAt || publishedAt.getTime() >= cutoff) {
      continue;
    }

    anomalies.backfilledCount++;
    if (
      !anomalies.oldestBackfilledPublishedAt ||
      publishedAt < anomalies.oldestBackfilledPublishedAt
    ) {
      anomalies.oldestBackfilledPublishedAt = publishedAt;
    }
    if (
      !anomalies.newestBackfilledPublishedAt ||
      publishedAt > anomalies.newestBackfilledPublishedAt
    ) {
      anomalies.newestBackfilledPublishedAt = publishedAt;
    }
  }

  return anomalies;
}

/**
 * Context identifying the ingest being reported.
 */
export interface FeedIngestContext {
  feedId: string;
  feedUrl: string | null;
  /** Whether the entries arrived via a scheduled/backup poll or a WebSub push. */
  source: FeedIngestSource;
  /** `feeds.last_fetched_at` as it was before this ingest. */
  previousFetchAt: Date | null;
}

/**
 * Detects and reports anomalies for one ingest: a warning per anomaly kind with
 * enough context to investigate, plus the Prometheus counters.
 *
 * @returns The detected anomalies, so callers can surface them in job metadata
 */
export function reportFeedIngestAnomalies(
  context: FeedIngestContext,
  parsedFeed: ParsedFeed,
  processed: ProcessEntriesResult
): FeedIngestAnomalies {
  const { feedId, feedUrl, source, previousFetchAt } = context;
  const anomalies = detectFeedIngestAnomalies(parsedFeed, processed, previousFetchAt);

  if (anomalies.droppedItemCount > 0) {
    trackFeedEntriesDropped(source, anomalies.droppedItemCount);
    logger.warn("Feed served more entries than the limit keeps", {
      feedId,
      feedUrl,
      source,
      servedItems: parsedFeed.totalItemCount,
      keptItems: parsedFeed.items.length,
      droppedItems: anomalies.droppedItemCount,
    });
  }

  if (anomalies.backfilledCount > 0) {
    trackFeedBackfilledEntries(source, anomalies.backfilledCount);
    logger.warn("Feed introduced entries published long before the previous fetch", {
      feedId,
      feedUrl,
      source,
      backfilledEntries: anomalies.backfilledCount,
      newEntries: processed.newCount,
      feedItems: parsedFeed.items.length,
      previousFetchAt: previousFetchAt?.toISOString(),
      oldestBackfilledPublishedAt: anomalies.oldestBackfilledPublishedAt?.toISOString(),
      newestBackfilledPublishedAt: anomalies.newestBackfilledPublishedAt?.toISOString(),
    });
  }

  return anomalies;
}

/**
 * Job handlers for processing different job types.
 *
 * Each handler executes a specific job type and returns a result that includes
 * the next run time for the job. The worker uses this to update the job record.
 *
 * See docs/job-queue-design.md for the overall architecture.
 */

import { createHash } from "crypto";
import { eq, and, isNull, sql } from "drizzle-orm";
import { db } from "../db";
import {
  feeds,
  subscriptions,
  entries,
  userEntries,
  opmlImports,
  type Feed,
  type OpmlImportFeedResult,
} from "../db/schema";
import {
  fetchFeed,
  parseFeed,
  processEntries,
  calculateNextFetch,
  renewExpiringSubscriptions,
  getDomainFromUrl,
  type FetchFeedResult,
  type ParsedCacheHeaders,
} from "../feed";
import {
  type JobPayloads,
  createOrEnableFeedJob,
  enableFeedJob,
  syncFeedJobEnabled,
} from "./queue";
import { subscribeToExistingFeed } from "../trpc/routers/subscriptions";
import { logger } from "@/lib/logger";
import { startFeedFetchTimer, trackWebsubRenewal, type FeedFetchStatus } from "../metrics/metrics";
import {
  publishImportProgress,
  publishImportCompleted,
  publishSubscriptionCreated,
} from "../redis/pubsub";
import { generateUuidv7 } from "@/lib/uuidv7";
import { isLessWrongUserFeedUrl } from "../feed/lesswrong";

/**
 * Result of a job handler execution.
 */
export interface JobHandlerResult {
  /** Whether the job completed successfully */
  success: boolean;
  /** When the job should next run */
  nextRunAt: Date;
  /** Error message if the job failed */
  error?: string;
  /** Any additional metadata about the job execution */
  metadata?: Record<string, unknown>;
}

/**
 * Handler for fetch_feed jobs.
 * Fetches a feed, processes entries, and returns the next fetch time.
 *
 * Note: This handler no longer checks for active subscribers - that's handled
 * by the job enable/disable mechanism. If a job is running, the feed has subscribers.
 *
 * @param payload - The job payload containing the feedId
 * @returns Job handler result with next run time
 */
export async function handleFetchFeed(
  payload: JobPayloads["fetch_feed"]
): Promise<JobHandlerResult> {
  const { feedId } = payload;

  logger.debug("Starting feed fetch", { feedId });

  // Start metrics timer for feed fetch
  const endFeedFetchTimer = startFeedFetchTimer();

  // Get the feed from the database
  const [feed] = await db.select().from(feeds).where(eq(feeds.id, feedId)).limit(1);

  if (!feed) {
    logger.warn("Feed not found for fetch job", { feedId });
    endFeedFetchTimer("error");
    // Schedule retry in 1 hour - feed might be deleted
    return {
      success: false,
      nextRunAt: new Date(Date.now() + 60 * 60 * 1000),
      error: `Feed not found: ${feedId}`,
    };
  }

  if (!feed.url) {
    logger.warn("Feed has no URL", { feedId });
    endFeedFetchTimer("error");
    // Email feeds don't have URLs - schedule far future retry
    return {
      success: false,
      nextRunAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
      error: `Feed has no URL: ${feedId}`,
    };
  }

  // Fetch the feed with conditional GET headers
  const fetchResult = await fetchFeed(feed.url, {
    etag: feed.etag ?? undefined,
    lastModified: feed.lastModifiedHeader ?? undefined,
    feedId,
  });

  // Process the result based on status
  const handlerResult = await processFetchResult(feed, fetchResult);

  // Map handler result to metrics status
  const metricsStatus: FeedFetchStatus = getMetricsStatus(fetchResult, handlerResult);
  endFeedFetchTimer(metricsStatus);

  // Log the result
  if (handlerResult.success) {
    logger.info("Feed fetched successfully", {
      feedId,
      url: feed.url,
      ...handlerResult.metadata,
    });
  } else {
    logger.warn("Feed fetch failed", {
      feedId,
      url: feed.url,
      error: handlerResult.error,
      ...handlerResult.metadata,
    });
  }

  return handlerResult;
}

/**
 * Maps fetch result and handler result to a metrics status.
 */
function getMetricsStatus(
  fetchResult: FetchFeedResult,
  handlerResult: JobHandlerResult
): FeedFetchStatus {
  if (fetchResult.status === "not_modified") {
    return "not_modified";
  }
  if (fetchResult.status === "success" && handlerResult.success) {
    return "success";
  }
  return "error";
}

/**
 * Processes a successful feed fetch.
 *
 * This is separated from processFetchResult to allow the raw body and parsed feed
 * to be garbage collected after entry processing completes, before the function returns.
 * This reduces peak memory usage for feeds with large content.
 *
 * @param feed - The feed record from the database
 * @param body - The raw feed body (XML/JSON string)
 * @param cacheHeaders - Parsed cache headers from the response
 * @param bodyHash - Pre-computed SHA-256 hash of the body
 * @param now - Current timestamp
 * @returns Job handler result with next run time
 */
async function processSuccessfulFetch(
  feed: Feed,
  body: string,
  cacheHeaders: ParsedCacheHeaders,
  bodyHash: string,
  now: Date
): Promise<JobHandlerResult> {
  // Parse the feed content
  let parsedFeed;
  try {
    parsedFeed = parseFeed(body);
  } catch (error) {
    // Parsing failed - treat as error
    const errorMessage = error instanceof Error ? error.message : "Failed to parse feed";
    const nextFetch = calculateNextFetch({
      consecutiveFailures: (feed.consecutiveFailures ?? 0) + 1,
      now,
    });
    await updateFeedOnError(feed.id, errorMessage, now, nextFetch.nextFetchAt);
    return {
      success: false,
      nextRunAt: nextFetch.nextFetchAt,
      error: errorMessage,
    };
  }

  // Extract metadata we need before processing entries
  // This allows parsedFeed.items (the large part) to be GC'd after processEntries
  let feedTitle = parsedFeed.title;

  // For LessWrong user feeds, append the author name to the feed title if not already present.
  // This gives us "LessWrong - Brendan Long" instead of just "LessWrong",
  // and automatically updates if the user changes their display name.
  if (feed.url && isLessWrongUserFeedUrl(feed.url)) {
    const firstAuthor = parsedFeed.items.find((item) => item.author)?.author;
    if (firstAuthor && feedTitle && !feedTitle.includes(firstAuthor)) {
      feedTitle = `${feedTitle} - ${firstAuthor}`;
    }
  }

  const feedMetadata = {
    title: feedTitle,
    description: parsedFeed.description,
    siteUrl: parsedFeed.siteUrl,
    hubUrl: parsedFeed.hubUrl,
    selfUrl: parsedFeed.selfUrl,
    ttlMinutes: parsedFeed.ttlMinutes,
    syndication: parsedFeed.syndication,
  };

  // Process entries (create new, update changed, detect disappeared)
  // Pass previousLastEntriesUpdatedAt to detect entries that disappeared from the feed
  // Pass feedUrl for feed-specific content cleaning (e.g., LessWrong)
  // After this call, parsedFeed can be GC'd since we only use feedMetadata below
  const processResult = await processEntries(feed.id, feed.type, parsedFeed, {
    fetchedAt: now,
    previousLastEntriesUpdatedAt: feed.lastEntriesUpdatedAt,
    feedUrl: feed.url ?? undefined,
  });

  // Calculate next fetch time based on cache headers and feed hints
  const nextFetch = calculateNextFetch({
    cacheControl: cacheHeaders.cacheControl,
    feedHints: {
      ttlMinutes: feedMetadata.ttlMinutes,
      syndication: feedMetadata.syndication,
    },
    consecutiveFailures: 0, // Reset failures on success
    now,
  });

  // Update feed metadata including WebSub hub discovery
  // Fall back to domain name if no title is available
  const fallbackTitle = feed.url ? getDomainFromUrl(feed.url) : undefined;

  // Only update lastEntriesUpdatedAt when entries actually changed (new, updated, or disappeared)
  // This timestamp must match entries.lastSeenAt for entries currently in the feed
  const lastEntriesUpdatedAt = processResult.hasChanges ? now : feed.lastEntriesUpdatedAt;

  await db
    .update(feeds)
    .set({
      title: feedMetadata.title || feed.title || fallbackTitle,
      description: feedMetadata.description || feed.description,
      siteUrl: feedMetadata.siteUrl || feed.siteUrl,
      etag: cacheHeaders.etag ?? feed.etag,
      lastModifiedHeader: cacheHeaders.lastModified ?? feed.lastModifiedHeader,
      bodyHash,
      lastFetchedAt: now,
      lastEntriesUpdatedAt,
      nextFetchAt: nextFetch.nextFetchAt,
      consecutiveFailures: 0,
      lastError: null,
      // Store WebSub hub and self URLs if discovered
      hubUrl: feedMetadata.hubUrl ?? feed.hubUrl,
      selfUrl: feedMetadata.selfUrl ?? feed.selfUrl,
      updatedAt: now,
    })
    .where(eq(feeds.id, feed.id));

  return {
    success: true,
    nextRunAt: nextFetch.nextFetchAt,
    metadata: {
      newEntries: processResult.newCount,
      updatedEntries: processResult.updatedCount,
      unchangedEntries: processResult.unchangedCount,
      disappearedEntries: processResult.disappearedCount,
      nextFetchReason: nextFetch.reason,
    },
  };
}

/**
 * Generates a SHA-256 hash of the feed body for change detection.
 */
function generateBodyHash(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

/**
 * Processes the fetch result and updates the feed accordingly.
 *
 * @param feed - The feed record from the database
 * @param result - The fetch result
 * @returns Job handler result with next run time
 */
async function processFetchResult(feed: Feed, result: FetchFeedResult): Promise<JobHandlerResult> {
  const now = new Date();

  switch (result.status) {
    case "success": {
      // Check if body is unchanged by comparing hashes
      const bodyHash = generateBodyHash(result.body);

      if (feed.bodyHash === bodyHash) {
        // Feed body unchanged - skip parsing and entry processing
        const nextFetch = calculateNextFetch({
          cacheControl: result.cacheHeaders.cacheControl,
          consecutiveFailures: 0,
          now,
        });

        await db
          .update(feeds)
          .set({
            lastFetchedAt: now,
            nextFetchAt: nextFetch.nextFetchAt,
            consecutiveFailures: 0,
            lastError: null,
            // Update cache headers even when body unchanged
            etag: result.cacheHeaders.etag ?? feed.etag,
            lastModifiedHeader: result.cacheHeaders.lastModified ?? feed.lastModifiedHeader,
            updatedAt: now,
          })
          .where(eq(feeds.id, feed.id));

        return {
          success: true,
          nextRunAt: nextFetch.nextFetchAt,
          metadata: {
            bodyUnchanged: true,
            nextFetchReason: nextFetch.reason,
          },
        };
      }

      // Process in a separate scope so large objects can be GC'd earlier
      return processSuccessfulFetch(feed, result.body, result.cacheHeaders, bodyHash, now);
    }

    case "not_modified": {
      // Feed hasn't changed - just update timestamps
      const nextFetch = calculateNextFetch({
        cacheControl: result.cacheHeaders.cacheControl,
        consecutiveFailures: 0,
        now,
      });

      await db
        .update(feeds)
        .set({
          lastFetchedAt: now,
          nextFetchAt: nextFetch.nextFetchAt,
          consecutiveFailures: 0,
          lastError: null,
          updatedAt: now,
        })
        .where(eq(feeds.id, feed.id));

      return {
        success: true,
        nextRunAt: nextFetch.nextFetchAt,
        metadata: {
          notModified: true,
          nextFetchReason: nextFetch.reason,
        },
      };
    }

    case "permanent_redirect": {
      // Check if a feed already exists at the redirect URL
      const [existingFeedAtRedirectUrl] = await db
        .select()
        .from(feeds)
        .where(eq(feeds.url, result.redirectUrl))
        .limit(1);

      if (existingFeedAtRedirectUrl) {
        // Feed exists at redirect URL - migrate subscriptions
        await migrateSubscriptionsToExistingFeed(feed, existingFeedAtRedirectUrl);

        logger.info("Migrated subscriptions due to redirect to existing feed", {
          oldFeedId: feed.id,
          oldUrl: feed.url,
          newFeedId: existingFeedAtRedirectUrl.id,
          newUrl: result.redirectUrl,
        });

        // The old feed's job will be disabled automatically when it has no subscribers
        // Schedule far future - if any new subscribers somehow appear, we'll redirect again
        return {
          success: true,
          nextRunAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000), // 30 days
          metadata: {
            redirected: true,
            mergedIntoFeedId: existingFeedAtRedirectUrl.id,
            newUrl: result.redirectUrl,
          },
        };
      }

      // No existing feed at redirect URL - update this feed's URL
      await db
        .update(feeds)
        .set({
          url: result.redirectUrl,
          lastFetchedAt: now,
          updatedAt: now,
        })
        .where(eq(feeds.id, feed.id));

      // Schedule immediate retry with new URL
      return {
        success: true,
        nextRunAt: now,
        metadata: {
          redirected: true,
          newUrl: result.redirectUrl,
        },
      };
    }

    case "client_error": {
      if (result.permanent) {
        // Permanent error (404, 410) - schedule far in future but don't stop entirely
        // The job will remain enabled in case the feed comes back
        const nextFetch = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000); // 7 days

        await db
          .update(feeds)
          .set({
            lastFetchedAt: now,
            nextFetchAt: nextFetch,
            consecutiveFailures: (feed.consecutiveFailures ?? 0) + 1,
            lastError: result.message,
            updatedAt: now,
          })
          .where(eq(feeds.id, feed.id));

        return {
          success: false,
          nextRunAt: nextFetch,
          error: result.message,
          metadata: {
            permanent: true,
          },
        };
      }

      // Temporary client error - backoff
      return handleTemporaryError(feed, result.message, now);
    }

    case "server_error":
    case "rate_limited":
    case "network_error":
    case "too_many_redirects": {
      // Temporary errors - backoff
      const errorMessage =
        result.status === "too_many_redirects"
          ? `Too many redirects (last: ${result.lastUrl})`
          : result.status === "rate_limited"
            ? `Rate limited${result.retryAfter ? ` (retry after ${result.retryAfter}s)` : ""}`
            : result.message;

      return handleTemporaryError(feed, errorMessage, now);
    }

    default: {
      // Exhaustive check - this should never be reached
      return result satisfies never;
    }
  }
}

/**
 * Handles temporary errors by calculating backoff and updating the feed.
 */
async function handleTemporaryError(
  feed: Feed,
  errorMessage: string,
  now: Date
): Promise<JobHandlerResult> {
  const newFailureCount = (feed.consecutiveFailures ?? 0) + 1;

  const nextFetch = calculateNextFetch({
    consecutiveFailures: newFailureCount,
    now,
  });

  await db
    .update(feeds)
    .set({
      lastFetchedAt: now,
      nextFetchAt: nextFetch.nextFetchAt,
      consecutiveFailures: newFailureCount,
      lastError: errorMessage,
      updatedAt: now,
    })
    .where(eq(feeds.id, feed.id));

  return {
    success: false,
    nextRunAt: nextFetch.nextFetchAt,
    error: errorMessage,
    metadata: {
      consecutiveFailures: newFailureCount,
    },
  };
}

/**
 * Updates feed on parsing/processing error.
 */
async function updateFeedOnError(
  feedId: string,
  errorMessage: string,
  now: Date,
  nextFetchAt: Date
): Promise<void> {
  const [feed] = await db.select().from(feeds).where(eq(feeds.id, feedId)).limit(1);

  if (!feed) return;

  const newFailureCount = (feed.consecutiveFailures ?? 0) + 1;

  await db
    .update(feeds)
    .set({
      lastFetchedAt: now,
      nextFetchAt: nextFetchAt,
      consecutiveFailures: newFailureCount,
      lastError: errorMessage,
      updatedAt: now,
    })
    .where(eq(feeds.id, feedId));
}

/**
 * Migrates all subscriptions from an old feed to an existing feed at the redirect URL.
 * Used when a permanent redirect is detected and the target URL already has a feed.
 *
 * For each subscriber:
 * 1. Creates subscription to new feed (skipping entries they've already seen from old feed)
 * 2. Migrates user_entries (read/starred state) from old feed entries to new feed entries
 * 3. Unsubscribes from old feed
 *
 * @param oldFeed - The feed that is being redirected
 * @param newFeed - The existing feed at the redirect URL
 */
async function migrateSubscriptionsToExistingFeed(oldFeed: Feed, newFeed: Feed): Promise<void> {
  // Find all active subscriptions to the old feed
  const activeSubscriptions = await db
    .select({ userId: subscriptions.userId, id: subscriptions.id })
    .from(subscriptions)
    .where(and(eq(subscriptions.feedId, oldFeed.id), isNull(subscriptions.unsubscribedAt)));

  if (activeSubscriptions.length === 0) {
    logger.debug("No active subscriptions to migrate", { oldFeedId: oldFeed.id });
    return;
  }

  logger.info("Migrating subscriptions to existing feed", {
    oldFeedId: oldFeed.id,
    newFeedId: newFeed.id,
    subscriptionCount: activeSubscriptions.length,
  });

  const now = new Date();

  for (const sub of activeSubscriptions) {
    try {
      // Subscribe to new feed, skipping entries they've already seen from old feed
      await subscribeToExistingFeed(db, sub.userId, newFeed, {
        previousFeedId: oldFeed.id,
        allowAlreadySubscribed: true,
      });

      // Migrate user_entries from old feed entries to new feed entries (matching by GUID)
      // This preserves read/starred state. On conflict, merge states using OR.
      await migrateUserEntries(sub.userId, oldFeed.id, newFeed.id, now);

      // Unsubscribe from old feed
      await db
        .update(subscriptions)
        .set({
          unsubscribedAt: now,
          updatedAt: now,
        })
        .where(eq(subscriptions.id, sub.id));

      logger.debug("Migrated subscription", {
        userId: sub.userId,
        oldFeedId: oldFeed.id,
        newFeedId: newFeed.id,
      });
    } catch (error) {
      // Log error but continue with other subscriptions
      logger.error("Failed to migrate subscription", {
        userId: sub.userId,
        oldFeedId: oldFeed.id,
        newFeedId: newFeed.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Sync the old feed's job - it will be disabled since it has no subscribers now
  await syncFeedJobEnabled(oldFeed.id);
}

/**
 * Migrates user_entries from old feed entries to new feed entries, matching by GUID.
 * Preserves read/starred state. On conflict (user already has entry in new feed),
 * merges states using OR (if either is read/starred, result is read/starred).
 */
async function migrateUserEntries(
  userId: string,
  oldFeedId: string,
  newFeedId: string,
  now: Date
): Promise<void> {
  // Use raw SQL for efficient upsert with join
  // This finds all user_entries for the old feed's entries, matches them to new feed
  // entries by GUID, and inserts/updates the user_entries for the new entries
  const result = await db.execute(sql`
    INSERT INTO ${userEntries} (user_id, entry_id, read, starred, updated_at)
    SELECT
      ${userId},
      new_entries.id,
      old_ue.read,
      old_ue.starred,
      ${now}
    FROM ${userEntries} old_ue
    JOIN ${entries} old_entries ON old_entries.id = old_ue.entry_id
    JOIN ${entries} new_entries ON new_entries.guid = old_entries.guid
      AND new_entries.feed_id = ${newFeedId}
    WHERE old_entries.feed_id = ${oldFeedId}
      AND old_ue.user_id = ${userId}
    ON CONFLICT (user_id, entry_id) DO UPDATE SET
      read = ${userEntries}.read OR EXCLUDED.read,
      starred = ${userEntries}.starred OR EXCLUDED.starred,
      updated_at = ${now}
  `);

  logger.debug("Migrated user entries", {
    userId,
    oldFeedId,
    newFeedId,
    rowCount: result.rowCount,
  });
}

/**
 * Handler for renew_websub jobs.
 * Renews WebSub subscriptions that are expiring soon.
 *
 * This job runs daily. It finds all active WebSub subscriptions expiring
 * within 24 hours and attempts to renew them.
 *
 * @param _payload - The job payload (empty for this job type)
 * @returns Job handler result with next run time (24 hours from now)
 */
export async function handleRenewWebsub(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _payload: JobPayloads["renew_websub"]
): Promise<JobHandlerResult> {
  logger.info("Starting WebSub subscription renewal check");

  const result = await renewExpiringSubscriptions(24); // 24 hours before expiry

  // Track renewal metrics
  for (let i = 0; i < result.renewed; i++) {
    trackWebsubRenewal(true);
  }
  for (let i = 0; i < result.failed; i++) {
    trackWebsubRenewal(false);
  }

  if (result.failed > 0) {
    logger.warn("Some WebSub renewals failed", {
      errors: result.errors,
    });
  }

  // Schedule next check for 24 hours from now
  const nextRunAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

  logger.debug("Scheduled next WebSub renewal check", {
    scheduledFor: nextRunAt.toISOString(),
  });

  return {
    success: true,
    nextRunAt,
    metadata: {
      checked: result.checked,
      renewed: result.renewed,
      failed: result.failed,
      errors: result.errors.length > 0 ? result.errors : undefined,
    },
  };
}

// Batch size for database updates during OPML import.
// Instead of updating the database after every feed (which causes freezes with large imports),
// we batch updates to reduce database load. Redis events still fire per-feed for real-time UI.
const OPML_IMPORT_DB_BATCH_SIZE = 10;

/**
 * Handler for process_opml_import jobs.
 * Processes an OPML import in the background, publishing progress events
 * as each feed is processed.
 *
 * This is a one-time job - it completes and is not rescheduled.
 *
 * @param payload - The job payload containing the importId
 * @returns Job handler result
 */
export async function handleProcessOpmlImport(
  payload: JobPayloads["process_opml_import"]
): Promise<JobHandlerResult> {
  const { importId } = payload;

  logger.info("Starting OPML import processing", { importId });

  // Get the import record
  const [importRecord] = await db
    .select()
    .from(opmlImports)
    .where(eq(opmlImports.id, importId))
    .limit(1);

  if (!importRecord) {
    logger.warn("Import record not found", { importId });
    return {
      success: false,
      nextRunAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000), // Far future - job won't run again
      error: `Import record not found: ${importId}`,
    };
  }

  // If already completed or failed, don't reprocess
  if (importRecord.status === "completed" || importRecord.status === "failed") {
    logger.info("Import already finished, skipping", { importId, status: importRecord.status });
    return {
      success: true,
      nextRunAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000), // Far future - job won't run again
    };
  }

  const userId = importRecord.userId;

  // Check if a previous run completed processing but crashed before updating status.
  // This can happen if the worker was killed between finishing the loop and the final update.
  // We detect this by checking if all feeds have been processed, using either:
  // 1. The results array length matching total feeds (most accurate)
  // 2. The counts adding up to total feeds (for cases where results array wasn't fully saved)
  const processedByResults = importRecord.results.length === importRecord.totalFeeds;
  const processedByCounts =
    importRecord.importedCount + importRecord.skippedCount + importRecord.failedCount ===
    importRecord.totalFeeds;

  if (importRecord.status === "processing" && (processedByResults || processedByCounts)) {
    // Use counts from results array if available, otherwise use stored counts
    const imported = processedByResults
      ? importRecord.results.filter((r) => r.status === "imported").length
      : importRecord.importedCount;
    const skipped = processedByResults
      ? importRecord.results.filter((r) => r.status === "skipped").length
      : importRecord.skippedCount;
    const failed = processedByResults
      ? importRecord.results.filter((r) => r.status === "failed").length
      : importRecord.failedCount;

    logger.info("Recovering previously completed import", {
      importId,
      imported,
      skipped,
      failed,
      total: importRecord.totalFeeds,
    });

    // Mark import as completed
    const completedAt = new Date();
    await db
      .update(opmlImports)
      .set({
        status: "completed",
        importedCount: imported,
        skippedCount: skipped,
        failedCount: failed,
        completedAt,
        updatedAt: completedAt,
      })
      .where(eq(opmlImports.id, importId));

    // Publish completed event
    await publishImportCompleted(userId, importId, {
      imported,
      skipped,
      failed,
      total: importRecord.totalFeeds,
    });

    return {
      success: true,
      nextRunAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000), // Far future - one-time job
      metadata: {
        recovered: true,
        imported,
        skipped,
        failed,
        total: importRecord.totalFeeds,
      },
    };
  }

  // Update status to processing
  await db
    .update(opmlImports)
    .set({ status: "processing", updatedAt: new Date() })
    .where(eq(opmlImports.id, importId));

  try {
    // Get existing subscriptions for the user
    const existingSubscriptions = await db
      .select({
        feedUrl: feeds.url,
      })
      .from(subscriptions)
      .innerJoin(feeds, eq(subscriptions.feedId, feeds.id))
      .where(and(eq(subscriptions.userId, userId), isNull(subscriptions.unsubscribedAt)));

    const existingUrls = new Set(existingSubscriptions.map((s) => s.feedUrl));

    // Process each feed
    const results: OpmlImportFeedResult[] = [];
    let imported = 0;
    let skipped = 0;
    let failed = 0;
    let feedsProcessedSinceLastDbUpdate = 0;

    // Helper to update import progress in database (batched to reduce load)
    const flushProgressToDb = async (force = false) => {
      feedsProcessedSinceLastDbUpdate++;
      if (force || feedsProcessedSinceLastDbUpdate >= OPML_IMPORT_DB_BATCH_SIZE) {
        await db
          .update(opmlImports)
          .set({
            importedCount: imported,
            skippedCount: skipped,
            failedCount: failed,
            results,
            updatedAt: new Date(),
          })
          .where(eq(opmlImports.id, importId));
        feedsProcessedSinceLastDbUpdate = 0;
      }
    };

    for (const opmlFeed of importRecord.feedsData) {
      const feedUrl = opmlFeed.xmlUrl;
      const feedTitle = opmlFeed.title ?? null;

      // Check if already subscribed
      if (existingUrls.has(feedUrl)) {
        results.push({
          url: feedUrl,
          title: feedTitle,
          status: "skipped",
          error: "Already subscribed",
        });
        skipped++;

        // Publish progress event
        await publishImportProgress(userId, importId, feedUrl, "skipped", {
          imported,
          skipped,
          failed,
          total: importRecord.totalFeeds,
        });

        // Update import record with current progress (batched)
        await flushProgressToDb();

        continue;
      }

      try {
        // Check if feed already exists in database
        const existingFeed = await db.select().from(feeds).where(eq(feeds.url, feedUrl)).limit(1);

        let feedId: string;

        if (existingFeed.length > 0) {
          // Feed exists - ensure job is enabled and sync next_fetch_at
          feedId = existingFeed[0].id;
          const job = await enableFeedJob(feedId);
          if (job?.nextRunAt) {
            await db
              .update(feeds)
              .set({ nextFetchAt: job.nextRunAt, updatedAt: new Date() })
              .where(eq(feeds.id, feedId));
          }
        } else {
          // Create new feed record
          feedId = generateUuidv7();
          const now = new Date();

          await db.insert(feeds).values({
            id: feedId,
            type: "web" as const, // All URL-based feeds use "web" type
            url: feedUrl,
            title: feedTitle,
            siteUrl: opmlFeed.htmlUrl ?? null,
            nextFetchAt: now, // Schedule immediate fetch
            createdAt: now,
            updatedAt: now,
          });

          // Create job for the new feed (enabled, runs immediately)
          await createOrEnableFeedJob(feedId);
        }

        // Check for existing soft-deleted subscription
        const existingSub = await db
          .select()
          .from(subscriptions)
          .where(and(eq(subscriptions.userId, userId), eq(subscriptions.feedId, feedId)))
          .limit(1);

        const now = new Date();
        const subscriptionId = generateUuidv7();
        let actualSubscriptionId = subscriptionId;

        if (existingSub.length > 0 && existingSub[0].unsubscribedAt !== null) {
          // Reactivate soft-deleted subscription
          actualSubscriptionId = existingSub[0].id;
          await db
            .update(subscriptions)
            .set({
              unsubscribedAt: null,
              subscribedAt: now,
              updatedAt: now,
            })
            .where(eq(subscriptions.id, actualSubscriptionId));
        } else if (existingSub.length === 0) {
          // Create new subscription
          await db.insert(subscriptions).values({
            id: subscriptionId,
            userId,
            feedId,
            subscribedAt: now,
            createdAt: now,
            updatedAt: now,
          });
        }

        // Publish subscription_created event (fire and forget)
        publishSubscriptionCreated(userId, feedId, actualSubscriptionId).catch((err) => {
          logger.error("Failed to publish subscription_created event", { err, userId, feedId });
        });

        // Add to existing URLs set to prevent duplicates within this import
        existingUrls.add(feedUrl);

        results.push({
          url: feedUrl,
          title: feedTitle,
          status: "imported",
          feedId,
          subscriptionId: actualSubscriptionId,
        });
        imported++;

        // Publish progress event
        await publishImportProgress(userId, importId, feedUrl, "imported", {
          imported,
          skipped,
          failed,
          total: importRecord.totalFeeds,
        });

        // Update import record with current progress (batched)
        await flushProgressToDb();

        logger.info("OPML import: feed imported", { feedUrl, userId, importId });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Unknown error";
        results.push({
          url: feedUrl,
          title: feedTitle,
          status: "failed",
          error: errorMessage,
        });
        failed++;

        // Publish progress event
        await publishImportProgress(userId, importId, feedUrl, "failed", {
          imported,
          skipped,
          failed,
          total: importRecord.totalFeeds,
        });

        // Update import record with current progress (batched)
        await flushProgressToDb();

        logger.warn("OPML import: feed import failed", {
          feedUrl,
          userId,
          importId,
          error: errorMessage,
        });
      }
    }

    // Mark import as completed
    const completedAt = new Date();
    await db
      .update(opmlImports)
      .set({
        status: "completed",
        importedCount: imported,
        skippedCount: skipped,
        failedCount: failed,
        results,
        completedAt,
        updatedAt: completedAt,
      })
      .where(eq(opmlImports.id, importId));

    // Publish completed event
    await publishImportCompleted(userId, importId, {
      imported,
      skipped,
      failed,
      total: importRecord.totalFeeds,
    });

    logger.info("OPML import completed", {
      importId,
      userId,
      imported,
      skipped,
      failed,
      total: importRecord.totalFeeds,
    });

    return {
      success: true,
      nextRunAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000), // Far future - one-time job
      metadata: {
        imported,
        skipped,
        failed,
        total: importRecord.totalFeeds,
      },
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";

    // Mark import as failed
    await db
      .update(opmlImports)
      .set({
        status: "failed",
        error: errorMessage,
        updatedAt: new Date(),
      })
      .where(eq(opmlImports.id, importId));

    logger.error("OPML import job failed", { importId, error: errorMessage });

    return {
      success: false,
      nextRunAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000), // Far future - don't retry
      error: errorMessage,
    };
  }
}

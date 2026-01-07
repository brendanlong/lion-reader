/**
 * Job handlers for processing different job types.
 *
 * Each handler executes a specific job type and returns a result that includes
 * the next run time for the job. The worker uses this to update the job record.
 *
 * See docs/job-queue-design.md for the overall architecture.
 */

import { eq, and, isNull } from "drizzle-orm";
import { db } from "../db";
import {
  feeds,
  subscriptions,
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
} from "../feed";
import { type JobPayloads, createOrEnableFeedJob, enableFeedJob } from "./queue";
import { logger } from "@/lib/logger";
import { startFeedFetchTimer, trackWebsubRenewal, type FeedFetchStatus } from "../metrics/metrics";
import {
  publishImportProgress,
  publishImportCompleted,
  publishSubscriptionCreated,
} from "../redis/pubsub";
import { generateUuidv7 } from "@/lib/uuidv7";

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
      // Parse the feed content
      let parsedFeed;
      try {
        parsedFeed = parseFeed(result.body);
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

      // Process entries (create new, update changed)
      const processResult = await processEntries(feed.id, parsedFeed, { fetchedAt: now });

      // Calculate next fetch time based on cache headers and feed hints
      const nextFetch = calculateNextFetch({
        cacheControl: result.cacheHeaders.cacheControl,
        feedHints: {
          ttlMinutes: parsedFeed.ttlMinutes,
          syndication: parsedFeed.syndication,
        },
        consecutiveFailures: 0, // Reset failures on success
        now,
      });

      // Update feed metadata including WebSub hub discovery
      // Fall back to domain name if no title is available
      const fallbackTitle = feed.url ? getDomainFromUrl(feed.url) : undefined;
      await db
        .update(feeds)
        .set({
          title: parsedFeed.title || feed.title || fallbackTitle,
          description: parsedFeed.description || feed.description,
          siteUrl: parsedFeed.siteUrl || feed.siteUrl,
          etag: result.cacheHeaders.etag ?? feed.etag,
          lastModifiedHeader: result.cacheHeaders.lastModified ?? feed.lastModifiedHeader,
          lastFetchedAt: now,
          nextFetchAt: nextFetch.nextFetchAt,
          consecutiveFailures: 0,
          lastError: null,
          // Store WebSub hub and self URLs if discovered
          hubUrl: parsedFeed.hubUrl ?? feed.hubUrl,
          selfUrl: parsedFeed.selfUrl ?? feed.selfUrl,
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
          nextFetchReason: nextFetch.reason,
        },
      };
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
      // Handle permanent redirect - update the feed URL
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
            type: "rss" as const, // Default to RSS, will be updated on first fetch
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

/**
 * Job handlers for processing different job types.
 *
 * Each handler executes a specific job type and returns a result that includes
 * the next run time for the job. The worker uses this to update the job record.
 *
 * See docs/job-queue-design.md for the overall architecture.
 */

import { eq } from "drizzle-orm";
import { db } from "../db";
import { feeds, type Feed } from "../db/schema";
import {
  fetchFeed,
  parseFeed,
  processEntries,
  calculateNextFetch,
  renewExpiringSubscriptions,
  type FetchFeedResult,
} from "../feed";
import { type JobPayloads } from "./queue";
import { logger } from "@/lib/logger";
import { startFeedFetchTimer, trackWebsubRenewal, type FeedFetchStatus } from "../metrics/metrics";

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

      // Calculate next fetch time based on cache headers
      const nextFetch = calculateNextFetch({
        cacheControl: result.cacheHeaders.cacheControl,
        consecutiveFailures: 0, // Reset failures on success
        now,
      });

      // Update feed metadata including WebSub hub discovery
      await db
        .update(feeds)
        .set({
          title: parsedFeed.title || feed.title,
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

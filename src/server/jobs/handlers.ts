/**
 * Job handlers for processing different job types.
 * Each handler is responsible for executing a specific job type.
 */

import { eq } from "drizzle-orm";
import { db } from "../db";
import { feeds, type Feed } from "../db/schema";
import {
  fetchFeed,
  parseFeed,
  processEntries,
  calculateNextFetch,
  type FetchFeedResult,
} from "../feed";
import { createJob, type JobPayloads } from "./queue";
import { logger } from "@/lib/logger";
import { startFeedFetchTimer, type FeedFetchStatus } from "../metrics/metrics";

/**
 * Result of a job handler execution.
 */
export interface JobHandlerResult {
  /** Whether the job completed successfully */
  success: boolean;
  /** Error message if the job failed */
  error?: string;
  /** Any additional metadata about the job execution */
  metadata?: Record<string, unknown>;
}

/**
 * Handler for fetch_feed jobs.
 * Fetches a feed, processes entries, and schedules the next fetch.
 *
 * @param payload - The job payload containing the feedId
 * @returns Job handler result
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
    return {
      success: false,
      error: `Feed not found: ${feedId}`,
    };
  }

  if (!feed.url) {
    logger.warn("Feed has no URL", { feedId });
    endFeedFetchTimer("error");
    return {
      success: false,
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
 * @returns Job handler result
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
        await updateFeedOnError(feed.id, errorMessage, now);
        return {
          success: false,
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

      // Schedule the next fetch job
      await scheduleNextFetch(feed.id, nextFetch.nextFetchAt);

      return {
        success: true,
        metadata: {
          newEntries: processResult.newCount,
          updatedEntries: processResult.updatedCount,
          unchangedEntries: processResult.unchangedCount,
          nextFetchAt: nextFetch.nextFetchAt.toISOString(),
          nextFetchReason: nextFetch.reason,
        },
      };
    }

    case "not_modified": {
      // Feed hasn't changed - just update timestamps and schedule next fetch
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

      await scheduleNextFetch(feed.id, nextFetch.nextFetchAt);

      return {
        success: true,
        metadata: {
          notModified: true,
          nextFetchAt: nextFetch.nextFetchAt.toISOString(),
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
      await scheduleNextFetch(feed.id, now);

      return {
        success: true,
        metadata: {
          redirected: true,
          newUrl: result.redirectUrl,
        },
      };
    }

    case "client_error": {
      if (result.permanent) {
        // Permanent error (404, 410) - stop fetching
        await db
          .update(feeds)
          .set({
            lastFetchedAt: now,
            nextFetchAt: null, // Don't schedule next fetch
            consecutiveFailures: (feed.consecutiveFailures ?? 0) + 1,
            lastError: result.message,
            updatedAt: now,
          })
          .where(eq(feeds.id, feed.id));

        return {
          success: false,
          error: result.message,
          metadata: {
            permanent: true,
          },
        };
      }

      // Temporary client error - increment failures and backoff
      return handleTemporaryError(feed, result.message, now);
    }

    case "server_error":
    case "rate_limited":
    case "network_error":
    case "too_many_redirects": {
      // Temporary errors - increment failures and backoff
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
 * Handles temporary errors by incrementing failure count and scheduling retry with backoff.
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

  await scheduleNextFetch(feed.id, nextFetch.nextFetchAt);

  return {
    success: false,
    error: errorMessage,
    metadata: {
      consecutiveFailures: newFailureCount,
      nextFetchAt: nextFetch.nextFetchAt.toISOString(),
    },
  };
}

/**
 * Updates feed on parsing/processing error.
 */
async function updateFeedOnError(feedId: string, errorMessage: string, now: Date): Promise<void> {
  const [feed] = await db.select().from(feeds).where(eq(feeds.id, feedId)).limit(1);

  if (!feed) return;

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
    .where(eq(feeds.id, feedId));

  await scheduleNextFetch(feedId, nextFetch.nextFetchAt);
}

/**
 * Schedules the next fetch job for a feed.
 *
 * @param feedId - The feed ID
 * @param scheduledFor - When to run the job
 */
async function scheduleNextFetch(feedId: string, scheduledFor: Date): Promise<void> {
  await createJob({
    type: "fetch_feed",
    payload: { feedId },
    scheduledFor,
    maxAttempts: 3,
  });
}

/**
 * Creates an initial fetch job for a newly subscribed feed.
 * Used when a user subscribes to a feed for the first time.
 *
 * @param feedId - The feed ID
 */
export async function createInitialFetchJob(feedId: string): Promise<void> {
  await createJob({
    type: "fetch_feed",
    payload: { feedId },
    scheduledFor: new Date(), // Run immediately
    maxAttempts: 3,
  });
}

/**
 * Handler for cleanup jobs.
 * Removes old completed jobs from the queue.
 *
 * @param payload - The job payload
 * @returns Job handler result
 */
export async function handleCleanup(payload: JobPayloads["cleanup"]): Promise<JobHandlerResult> {
  const { olderThanDays = 7 } = payload;

  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - olderThanDays);

  // Import here to avoid circular dependency
  const { deleteCompletedJobs } = await import("./queue");
  const deletedCount = await deleteCompletedJobs(cutoffDate);

  return {
    success: true,
    metadata: {
      deletedJobs: deletedCount,
      cutoffDate: cutoffDate.toISOString(),
    },
  };
}

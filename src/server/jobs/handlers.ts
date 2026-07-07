/**
 * Job handlers for processing different job types.
 *
 * Each handler executes a specific job type and returns a result that includes
 * the next run time for the job. The worker uses this to update the job record.
 *
 * See docs/job-queue-design.md for the overall architecture.
 */

import { createHash } from "crypto";
import { eq, and, isNull, inArray, count } from "drizzle-orm";
import { db } from "../db";
import {
  feeds,
  subscriptions,
  subscriptionFeeds,
  entries,
  opmlImports,
  tags,
  subscriptionTags,
  type Feed,
  type OpmlImportFeedResult,
} from "../db/schema";
import { fetchFullContent, persistFullContentResult } from "../services/full-content";
import { fetchFeed, type FetchFeedResult, type RedirectInfo } from "../feed/fetcher";
import type { WebSubLinkHeaders } from "../feed/link-header";
import { parseFeed } from "../feed/parser";
import { processEntries } from "../feed/entry-processor";
import { calculateNextFetch } from "../feed/scheduling";
import {
  renewExpiringSubscriptions,
  canUseWebSub,
  subscribeToHub,
  deactivateWebsub,
  resolveWebsubAction,
} from "../feed/websub";
import { recordBackupPollNewEntries } from "../feed/websub-hub-stats";
import { getDomainFromUrl } from "../feed/types";
import type { ParsedCacheHeaders } from "../feed/cache-headers";
import {
  getFeedFetchHealthSnapshot,
  evaluateFeedFetchHealth,
  buildFeedHealthPingBody,
} from "../feed/health";
import { pingHealthcheck } from "../notifications/healthchecks";
import { feedHealthConfig } from "../config/env";
import { type JobPayloads, ensureFeedJob } from "./queue";
import { logger } from "@/lib/logger";
import {
  startFeedFetchTimer,
  trackWebsubRenewal,
  updateFeedHealthMetrics,
  type FeedFetchStatus,
} from "../metrics/metrics";
import {
  publishImportProgress,
  publishImportCompleted,
  publishSubscriptionUpdated,
} from "../redis/pubsub";
import { generateUuidv7 } from "@/lib/uuidv7";
import { getFeedPlugin } from "@/server/plugins";
import { createSubscription } from "../services/subscriptions";
import { runRetentionCleanup } from "../services/retention";
import { resanitizeStaleEntries } from "../services/resanitize";
import { SANITIZER_VERSION } from "../html/sanitize";
import {
  findPermanentRedirectUrl,
  isHttpToHttpsUpgrade,
  REDIRECT_WAIT_PERIOD_MS,
} from "../feed/redirect-utils";

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
 * Maximum number of entries to fetch full content for per feed fetch.
 * This prevents timeout issues for feeds with many new entries.
 */
const MAX_FULL_CONTENT_ENTRIES_PER_FETCH = 10;

/**
 * Fetches full content for new entries if any subscriber has fetchFullContent enabled.
 *
 * This is called after processEntries() to fetch the full article content
 * from the URL for entries that only have a summary in the feed.
 *
 * @param feedId - The feed's UUID
 * @param newEntryIds - Array of new entry IDs to potentially fetch full content for
 * @returns Number of entries with full content fetched
 */
async function fetchFullContentForNewEntries(
  feedId: string,
  newEntryIds: string[]
): Promise<{ fetched: number; failed: number }> {
  if (newEntryIds.length === 0) {
    return { fetched: 0, failed: 0 };
  }

  // Check if any active subscriber has fetchFullContent enabled
  const subscribersWithFullContent = await db
    .select({ userId: subscriptions.userId })
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.feedId, feedId),
        isNull(subscriptions.unsubscribedAt),
        eq(subscriptions.fetchFullContent, true)
      )
    )
    .limit(1);

  if (subscribersWithFullContent.length === 0) {
    return { fetched: 0, failed: 0 };
  }

  logger.debug("Full content fetching enabled for feed", {
    feedId,
    newEntryCount: newEntryIds.length,
  });

  // Get entries with URLs (limit to avoid timeout)
  const entriesToFetch = await db
    .select({ id: entries.id, url: entries.url })
    .from(entries)
    .where(inArray(entries.id, newEntryIds.slice(0, MAX_FULL_CONTENT_ENTRIES_PER_FETCH)));

  const entriesWithUrls = entriesToFetch.filter((e) => e.url !== null);

  if (entriesWithUrls.length === 0) {
    return { fetched: 0, failed: 0 };
  }

  let fetched = 0;
  let failed = 0;

  // Fetch full content for each entry sequentially to avoid overwhelming servers
  for (const entry of entriesWithUrls) {
    try {
      // This is a background job (off the request path), so run Readability
      // inline rather than offloading to a worker — the thread hop is pure
      // overhead here.
      const result = await fetchFullContent(entry.url!, { offloadClean: false });
      // Persists the result (sanitized at write time so the user's first
      // read is fast) or the fetch error onto the shared entry row. Sanitize
      // inline too, for the same reason.
      const update = await persistFullContentResult(db, entry.id, result, new Date(), {
        offloadSanitize: false,
      });

      if (update) {
        fetched++;
        logger.debug("Fetched full content for entry", {
          entryId: entry.id,
          url: entry.url,
        });
      } else {
        failed++;
        logger.debug("Failed to fetch full content for entry", {
          entryId: entry.id,
          url: entry.url,
          error: result.error,
        });
      }
    } catch (error) {
      failed++;
      logger.warn("Error fetching full content for entry", {
        entryId: entry.id,
        url: entry.url,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  logger.info("Full content fetching completed", {
    feedId,
    fetched,
    failed,
    total: entriesWithUrls.length,
  });

  return { fetched, failed };
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

  // Count active subscribers for the user agent (useful for publishers)
  const [{ subscriberCount }] = await db
    .select({ subscriberCount: count() })
    .from(subscriptions)
    .where(and(eq(subscriptions.feedId, feedId), isNull(subscriptions.unsubscribedAt)));

  // Fetch the feed with conditional GET headers
  const fetchResult = await fetchFeed(feed.url, {
    etag: feed.etag ?? undefined,
    lastModified: feed.lastModifiedHeader ?? undefined,
    feedId,
    subscriberCount,
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
 * @param body - The raw feed body bytes (avoids text decoding until needed)
 * @param cacheHeaders - Parsed cache headers from the response
 * @param bodyHash - Pre-computed SHA-256 hash of the body
 * @param redirects - The redirect chain from the fetch
 * @param websubLinks - WebSub hub and self URLs from HTTP Link headers
 * @param now - Current timestamp
 * @returns Job handler result with next run time
 */
async function processSuccessfulFetch(
  feed: Feed,
  body: Buffer,
  cacheHeaders: ParsedCacheHeaders,
  bodyHash: string,
  redirects: RedirectInfo[],
  websubLinks: WebSubLinkHeaders,
  now: Date
): Promise<JobHandlerResult> {
  // Decode to string for parsing (we only get here when hash differs, so content changed)
  const bodyText = body.toString("utf-8");

  // Parse the feed content
  let parsedFeed;
  try {
    parsedFeed = parseFeed(bodyText);
  } catch (error) {
    // Parsing failed - treat as error
    // Also clear any redirect tracking since the destination doesn't have a valid feed
    if (feed.redirectUrl) {
      await clearRedirectTracking(feed.id, now);
    }
    const errorMessage = error instanceof Error ? error.message : "Failed to parse feed";
    const nextFetch = calculateNextFetch({
      consecutiveFailures: (feed.consecutiveFailures ?? 0) + 1,
      websubActive: feed.websubActive ?? false,
      now,
    });
    await updateFeedOnError(feed.id, errorMessage, now, nextFetch.nextFetchAt);
    return {
      success: false,
      nextRunAt: nextFetch.nextFetchAt,
      error: errorMessage,
    };
  }

  // Check for permanent redirects now that we know the destination has a valid feed
  const permanentRedirectUrl = feed.url ? findPermanentRedirectUrl(redirects, feed.url) : null;

  if (permanentRedirectUrl) {
    // Handle the permanent redirect (track or apply based on wait period)
    const redirectResult = await handlePermanentRedirect(feed, permanentRedirectUrl, now);

    if (redirectResult.applied) {
      // Redirect was applied - return early with the redirect result
      return {
        success: true,
        nextRunAt: redirectResult.nextRunAt ?? now,
        metadata: redirectResult.metadata,
      };
    }
    // Redirect is being tracked but not yet applied - continue with normal processing
  } else if (feed.redirectUrl) {
    // No permanent redirect in this fetch - clear tracking (redirect was temporary or reverted)
    await clearRedirectTracking(feed.id, now);
  }

  // Extract metadata we need before processing entries
  // This allows parsedFeed.items (the large part) to be GC'd after processEntries
  let feedTitle = parsedFeed.title;

  // Let a matching plugin transform the feed title. For LessWrong user feeds this
  // appends the author name (e.g. "LessWrong - Brendan Long" instead of just
  // "LessWrong"), and automatically updates if the user changes their display name.
  if (feed.url && feedTitle) {
    const transformTitle = getFeedPlugin(feed.url)?.capabilities.feed.transformFeedTitle;
    if (transformTitle) {
      // Isolate plugin failures: a throwing hook must not fail the whole fetch.
      // Fall back to the untransformed title.
      try {
        const firstAuthor = parsedFeed.items.find((item) => item.author)?.author ?? null;
        feedTitle = transformTitle(feedTitle, new URL(feed.url), { firstAuthor });
      } catch (error) {
        logger.warn("Plugin transformFeedTitle hook threw; using untransformed title", {
          feedId: feed.id,
          feedUrl: feed.url,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  const feedMetadata = {
    title: feedTitle,
    description: parsedFeed.description,
    siteUrl: parsedFeed.siteUrl,
    // HTTP Link headers take precedence over embedded feed links per W3C WebSub spec §4
    hubUrl: websubLinks.hubUrl ?? parsedFeed.hubUrl,
    selfUrl: websubLinks.selfUrl ?? parsedFeed.selfUrl,
    ttlMinutes: parsedFeed.ttlMinutes,
    syndication: parsedFeed.syndication,
  };

  // Resolved feed title, falling back to the domain name. Must match what the
  // feeds.title update below stores, so new_entry events carry the same title
  // a later entries.list refetch would return.
  const fallbackTitle = feed.url ? getDomainFromUrl(feed.url) : undefined;
  const resolvedFeedTitle = feedMetadata.title || feed.title || fallbackTitle || null;

  // Process entries (create new, update changed, detect disappeared)
  // Pass previousLastEntriesUpdatedAt to detect entries that disappeared from the feed
  // Pass feedUrl for feed-specific content cleaning (e.g., LessWrong)
  // After this call, parsedFeed can be GC'd since we only use feedMetadata below
  const processResult = await processEntries(feed.id, feed.type, parsedFeed, {
    fetchedAt: now,
    previousLastEntriesUpdatedAt: feed.lastEntriesUpdatedAt,
    feedUrl: feed.url ?? undefined,
    feedTitle: resolvedFeedTitle,
  });

  // Fetch full content for new entries if any subscriber has fetchFullContent enabled
  // This is done after processEntries so entries exist in the database
  const newEntries = processResult.entries.filter((e) => e.isNew);
  const newEntryIds = newEntries.map((e) => e.id);
  const fullContentResult = await fetchFullContentForNewEntries(feed.id, newEntryIds);

  // Push-reliability telemetry: this handler only runs for scheduled/backup
  // polls (hub pushes go through ingestWebsubNotification, not here). If push
  // were working, the hub would already have delivered these entries, so any
  // new entry a backup poll finds on a feed we believed push was covering is a
  // push miss. Record it per hub for later analysis (see websub-hub-stats.ts).
  if ((feed.websubActive ?? false) && feed.hubUrl && newEntries.length > 0) {
    await recordBackupPollNewEntries(
      feed.hubUrl,
      newEntries.map((e) => e.newEntryData?.publishedAt),
      now
    );
  }

  // Calculate next fetch time based on cache headers and feed hints
  const nextFetch = calculateNextFetch({
    cacheControl: cacheHeaders.cacheControl,
    feedHints: {
      ttlMinutes: feedMetadata.ttlMinutes,
      syndication: feedMetadata.syndication,
    },
    consecutiveFailures: 0, // Reset failures on success
    websubActive: feed.websubActive ?? false,
    now,
  });

  // Update feed metadata including WebSub hub discovery

  // Only update lastEntriesUpdatedAt when entries actually changed (new, updated, or disappeared)
  // This timestamp must match entries.lastSeenAt for entries currently in the feed
  const lastEntriesUpdatedAt = processResult.hasChanges ? now : feed.lastEntriesUpdatedAt;

  // Determine the new hub URL state
  // If the feed content has a hub URL, use it; otherwise clear it
  // (falling back to old value would prevent detecting when a feed removes WebSub)
  const newHubUrl = feedMetadata.hubUrl ?? null;
  const newSelfUrl = feedMetadata.selfUrl ?? feed.selfUrl;

  // Calculate the number of entries seen in this fetch
  const lastFetchEntryCount =
    processResult.newCount + processResult.updatedCount + processResult.unchangedCount;

  await db
    .update(feeds)
    .set({
      title: resolvedFeedTitle,
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
      // Store WebSub hub and self URLs from feed content
      hubUrl: newHubUrl,
      selfUrl: newSelfUrl,
      // Feed fetch statistics
      lastFetchEntryCount,
      lastFetchSizeBytes: body.length,
      updatedAt: now,
    })
    .where(eq(feeds.id, feed.id));

  // Handle WebSub subscription changes
  const websubMetadata: Record<string, unknown> = {};

  const websubAction = resolveWebsubAction({
    previousHubUrl: feed.hubUrl,
    previousWebsubActive: feed.websubActive ?? false,
    newHubUrl,
    canUseWebSub: canUseWebSub(),
  });

  if (websubAction === "subscribe" || websubAction === "resubscribe") {
    // On a hub switch, tear down the stale subscription to the old hub first so
    // we don't leave a dangling active row pointed at a hub that will never
    // deliver again. deactivateWebsub also clears websubActive, so it stays
    // false until the new hub verifies our subscription.
    if (websubAction === "resubscribe") {
      await deactivateWebsub(feed.id);
      websubMetadata.websubHubChanged = true;
      logger.info("WebSub hub URL changed - resubscribing to new hub", {
        feedId: feed.id,
        previousHubUrl: feed.hubUrl,
        newHubUrl,
      });
    }
    const updatedFeed: Feed = {
      ...feed,
      hubUrl: newHubUrl,
      selfUrl: newSelfUrl,
    };
    const subscribeResult = await subscribeToHub(updatedFeed);
    if (subscribeResult.success) {
      websubMetadata.websubSubscribed = true;
      logger.info("Initiated WebSub subscription for feed", {
        feedId: feed.id,
        hubUrl: newHubUrl,
      });
    } else {
      websubMetadata.websubSubscribeFailed = subscribeResult.error;
      logger.warn("Failed to subscribe to WebSub hub", {
        feedId: feed.id,
        hubUrl: newHubUrl,
        error: subscribeResult.error,
      });
    }
  } else if (websubAction === "deactivate") {
    // Feed had WebSub active but hub URL is now gone - deactivate
    await deactivateWebsub(feed.id);
    websubMetadata.websubDeactivated = true;
    logger.info("Deactivated WebSub - hub URL removed from feed", {
      feedId: feed.id,
      previousHubUrl: feed.hubUrl,
    });
  }

  // Build full content metadata if any were fetched
  const fullContentMetadata: Record<string, unknown> =
    fullContentResult.fetched > 0 || fullContentResult.failed > 0
      ? {
          fullContentFetched: fullContentResult.fetched,
          fullContentFailed: fullContentResult.failed,
        }
      : {};

  return {
    success: true,
    nextRunAt: nextFetch.nextFetchAt,
    metadata: {
      newEntries: processResult.newCount,
      updatedEntries: processResult.updatedCount,
      unchangedEntries: processResult.unchangedCount,
      disappearedEntries: processResult.disappearedCount,
      nextFetchReason: nextFetch.reason,
      ...websubMetadata,
      ...fullContentMetadata,
    },
  };
}

/**
 * Generates a SHA-256 hash of the feed body for change detection.
 * Accepts raw bytes to avoid text decoding until we know content has changed.
 */
function generateBodyHash(body: Buffer): string {
  return createHash("sha256").update(body).digest("hex");
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
        // But still check for permanent redirects (we know the content was valid before)
        const permanentRedirectUrl = feed.url
          ? findPermanentRedirectUrl(result.redirects, feed.url)
          : null;

        if (permanentRedirectUrl) {
          const redirectResult = await handlePermanentRedirect(feed, permanentRedirectUrl, now);
          if (redirectResult.applied) {
            return {
              success: true,
              nextRunAt: redirectResult.nextRunAt ?? now,
              metadata: { ...redirectResult.metadata, bodyUnchanged: true },
            };
          }
        } else if (feed.redirectUrl) {
          // No permanent redirect - clear tracking
          await clearRedirectTracking(feed.id, now);
        }

        const nextFetch = calculateNextFetch({
          cacheControl: result.cacheHeaders.cacheControl,
          consecutiveFailures: 0,
          websubActive: feed.websubActive ?? false,
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
      return processSuccessfulFetch(
        feed,
        result.body,
        result.cacheHeaders,
        bodyHash,
        result.redirects,
        result.websubLinks,
        now
      );
    }

    case "not_modified": {
      // Feed hasn't changed - just update timestamps
      // But still check for permanent redirects (we know the content was valid before)
      const permanentRedirectUrl = feed.url
        ? findPermanentRedirectUrl(result.redirects, feed.url)
        : null;

      if (permanentRedirectUrl) {
        const redirectResult = await handlePermanentRedirect(feed, permanentRedirectUrl, now);
        if (redirectResult.applied) {
          return {
            success: true,
            nextRunAt: redirectResult.nextRunAt ?? now,
            metadata: { ...redirectResult.metadata, notModified: true },
          };
        }
      } else if (feed.redirectUrl) {
        // No permanent redirect - clear tracking
        await clearRedirectTracking(feed.id, now);
      }

      const nextFetch = calculateNextFetch({
        cacheControl: result.cacheHeaders.cacheControl,
        consecutiveFailures: 0,
        websubActive: feed.websubActive ?? false,
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

    // Note: The fetcher follows all redirects itself and returns success/not_modified
    // with the redirect chain included; permanent redirects are detected from that chain
    // via findPermanentRedirectUrl and applied through the 7-day-wait logic in
    // handlePermanentRedirect. There is deliberately no separate "permanent_redirect"
    // fetch result — applying a redirect immediately here would contradict that wait.

    case "client_error": {
      if (result.permanent) {
        // Permanent error (404, 410) - the original URL is broken
        // If we have a tracked redirect URL, apply it immediately since the original is gone
        if (feed.redirectUrl) {
          logger.info("Original URL broken, applying tracked redirect", {
            feedId: feed.id,
            originalUrl: feed.url,
            redirectUrl: feed.redirectUrl,
            error: result.message,
          });

          const redirectResult = await applyRedirectMigration(feed, feed.redirectUrl, now);
          return {
            success: true,
            nextRunAt: redirectResult.nextRunAt ?? now,
            metadata: {
              ...redirectResult.metadata,
              originalUrlBroken: true,
              originalError: result.message,
            },
          };
        }

        // No tracked redirect - schedule far in future but don't stop entirely
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

    case "content_too_large": {
      // Feed is too large - this is a persistent error, schedule far in future
      const nextFetch = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000); // 7 days
      await updateFeedOnError(feed.id, result.message, now, nextFetch);
      return {
        success: false,
        nextRunAt: nextFetch,
        error: result.message,
        metadata: {
          permanent: true,
          maxBytes: result.maxBytes,
        },
      };
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

      // 429 and 5xx may carry a Retry-After; honor it as a floor on the backoff.
      const retryAfterSeconds =
        result.status === "rate_limited" || result.status === "server_error"
          ? result.retryAfter
          : undefined;

      return handleTemporaryError(feed, errorMessage, now, retryAfterSeconds);
    }

    default: {
      // Exhaustive check - this should never be reached
      return result satisfies never;
    }
  }
}

/**
 * Handles temporary errors by calculating backoff and updating the feed.
 *
 * @param retryAfterSeconds - Server-requested retry delay (Retry-After header),
 *   honored as a floor on the exponential backoff when present.
 */
async function handleTemporaryError(
  feed: Feed,
  errorMessage: string,
  now: Date,
  retryAfterSeconds?: number
): Promise<JobHandlerResult> {
  const newFailureCount = (feed.consecutiveFailures ?? 0) + 1;

  const nextFetch = calculateNextFetch({
    consecutiveFailures: newFailureCount,
    retryAfterSeconds,
    websubActive: feed.websubActive ?? false,
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

// ============================================================================
// REDIRECT TRACKING
// ============================================================================

/**
 * Clears redirect tracking fields on a feed.
 *
 * @param feedId - The feed ID
 * @param now - Current timestamp
 */
async function clearRedirectTracking(feedId: string, now: Date): Promise<void> {
  await db
    .update(feeds)
    .set({
      redirectUrl: null,
      redirectFirstSeenAt: null,
      updatedAt: now,
    })
    .where(eq(feeds.id, feedId));
}

/**
 * Handles a permanent redirect by either:
 * - Applying it immediately (HTTP->HTTPS upgrade or wait period exceeded)
 * - Starting/updating tracking (new redirect or within wait period)
 * - Returns true if the redirect was applied and the feed URL was changed
 *
 * @param feed - The feed record
 * @param redirectUrl - The permanent redirect URL
 * @param now - Current timestamp
 * @returns Object with applied flag and metadata
 */
async function handlePermanentRedirect(
  feed: Feed,
  redirectUrl: string,
  now: Date
): Promise<{
  applied: boolean;
  metadata: Record<string, unknown>;
  nextRunAt?: Date;
}> {
  // Check for HTTP -> HTTPS upgrade (apply immediately)
  if (feed.url && isHttpToHttpsUpgrade(feed.url, redirectUrl)) {
    logger.info("Applying HTTP to HTTPS redirect immediately", {
      feedId: feed.id,
      oldUrl: feed.url,
      newUrl: redirectUrl,
    });

    return applyRedirectMigration(feed, redirectUrl, now);
  }

  // Check if we're tracking a different redirect URL
  if (feed.redirectUrl && feed.redirectUrl !== redirectUrl) {
    // Redirect destination changed - start tracking the new one
    logger.info("Redirect URL changed, resetting tracking", {
      feedId: feed.id,
      previousRedirectUrl: feed.redirectUrl,
      newRedirectUrl: redirectUrl,
    });

    await db
      .update(feeds)
      .set({
        redirectUrl: redirectUrl,
        redirectFirstSeenAt: now,
        updatedAt: now,
      })
      .where(eq(feeds.id, feed.id));

    return {
      applied: false,
      metadata: { redirectTracking: "reset", redirectUrl },
    };
  }

  // Check if we're already tracking this redirect
  if (feed.redirectUrl === redirectUrl && feed.redirectFirstSeenAt) {
    const timeSinceFirstSeen = now.getTime() - feed.redirectFirstSeenAt.getTime();

    if (timeSinceFirstSeen >= REDIRECT_WAIT_PERIOD_MS) {
      // Wait period exceeded - apply the redirect
      logger.info("Redirect wait period exceeded, applying migration", {
        feedId: feed.id,
        oldUrl: feed.url,
        newUrl: redirectUrl,
        waitedDays: Math.floor(timeSinceFirstSeen / (24 * 60 * 60 * 1000)),
      });

      return applyRedirectMigration(feed, redirectUrl, now);
    }

    // Still within wait period
    const daysRemaining = Math.ceil(
      (REDIRECT_WAIT_PERIOD_MS - timeSinceFirstSeen) / (24 * 60 * 60 * 1000)
    );

    logger.debug("Redirect wait period not yet exceeded", {
      feedId: feed.id,
      redirectUrl,
      daysRemaining,
    });

    return {
      applied: false,
      metadata: { redirectTracking: "waiting", redirectUrl, daysRemaining },
    };
  }

  // Start tracking new redirect
  logger.info("Starting redirect tracking", {
    feedId: feed.id,
    feedUrl: feed.url,
    redirectUrl,
  });

  await db
    .update(feeds)
    .set({
      redirectUrl: redirectUrl,
      redirectFirstSeenAt: now,
      updatedAt: now,
    })
    .where(eq(feeds.id, feed.id));

  return {
    applied: false,
    metadata: { redirectTracking: "started", redirectUrl },
  };
}

/**
 * Applies a permanent redirect migration.
 * Either updates the feed URL or migrates subscriptions to an existing feed.
 *
 * @param feed - The feed to migrate
 * @param redirectUrl - The redirect destination URL
 * @param now - Current timestamp
 * @returns Result with metadata about what happened
 */
async function applyRedirectMigration(
  feed: Feed,
  redirectUrl: string,
  now: Date
): Promise<{
  applied: boolean;
  metadata: Record<string, unknown>;
  nextRunAt?: Date;
}> {
  // Check if a feed already exists at the redirect URL
  const [existingFeedAtRedirectUrl] = await db
    .select()
    .from(feeds)
    .where(eq(feeds.url, redirectUrl))
    .limit(1);

  if (existingFeedAtRedirectUrl) {
    // Feed exists at redirect URL - migrate subscriptions
    await migrateSubscriptionsToExistingFeed(feed, existingFeedAtRedirectUrl);

    logger.info("Migrated subscriptions due to redirect to existing feed", {
      oldFeedId: feed.id,
      oldUrl: feed.url,
      newFeedId: existingFeedAtRedirectUrl.id,
      newUrl: redirectUrl,
    });

    // The old feed's job will be disabled automatically when it has no subscribers
    // Schedule far future - if any new subscribers somehow appear, we'll redirect again
    return {
      applied: true,
      nextRunAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000), // 30 days
      metadata: {
        redirectApplied: true,
        mergedIntoFeedId: existingFeedAtRedirectUrl.id,
        newUrl: redirectUrl,
      },
    };
  }

  // No existing feed at redirect URL - update this feed's URL
  await db
    .update(feeds)
    .set({
      url: redirectUrl,
      redirectUrl: null,
      redirectFirstSeenAt: null,
      lastFetchedAt: now,
      updatedAt: now,
    })
    .where(eq(feeds.id, feed.id));

  logger.info("Updated feed URL due to redirect", {
    feedId: feed.id,
    oldUrl: feed.url,
    newUrl: redirectUrl,
  });

  // Schedule immediate retry with new URL
  return {
    applied: true,
    nextRunAt: now,
    metadata: {
      redirectApplied: true,
      newUrl: redirectUrl,
    },
  };
}

/**
 * Migrates all subscriptions from an old feed to an existing feed at the redirect URL.
 * Used when a permanent redirect is detected and the target URL already has a feed.
 *
 * For each subscriber:
 * 1. Creates or updates subscription to new feed, adding old feed ID to subscription_feeds
 * 2. Unsubscribes from old feed
 *
 * User entries stay linked to entries in the old feed. Entry queries use
 * the subscription_feeds junction table to find all relevant entries.
 *
 * @param oldFeed - The feed that is being redirected
 * @param newFeed - The existing feed at the redirect URL
 */
export async function migrateSubscriptionsToExistingFeed(
  oldFeed: Feed,
  newFeed: Feed
): Promise<void> {
  // Find all active subscriptions to the old feed
  const activeSubscriptions = await db
    .select({
      userId: subscriptions.userId,
      id: subscriptions.id,
    })
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
  const userIds = activeSubscriptions.map((s) => s.userId);
  const oldSubIds = activeSubscriptions.map((s) => s.id);

  // Batch query: Get all existing subscriptions to the new feed for affected users
  const existingNewSubs = await db
    .select({
      id: subscriptions.id,
      userId: subscriptions.userId,
      unsubscribedAt: subscriptions.unsubscribedAt,
    })
    .from(subscriptions)
    .where(and(eq(subscriptions.feedId, newFeed.id), inArray(subscriptions.userId, userIds)));

  // Build lookup map: userId -> existing subscription to new feed
  const existingSubByUser = new Map(existingNewSubs.map((s) => [s.userId, s]));

  // Separate users into those with and without existing subscriptions to new feed
  const usersWithExisting: Array<{
    userId: string;
    existingSubId: string;
    wasUnsubscribed: boolean;
  }> = [];
  const usersWithoutExisting: string[] = [];

  for (const sub of activeSubscriptions) {
    const existing = existingSubByUser.get(sub.userId);
    if (existing) {
      usersWithExisting.push({
        userId: sub.userId,
        existingSubId: existing.id,
        wasUnsubscribed: existing.unsubscribedAt !== null,
      });
    } else {
      usersWithoutExisting.push(sub.userId);
    }
  }

  // For users with existing subscriptions: reactivate if needed and add old feed to subscription_feeds
  for (const user of usersWithExisting) {
    if (user.wasUnsubscribed) {
      await db
        .update(subscriptions)
        .set({
          unsubscribedAt: null,
          subscribedAt: now,
          updatedAt: now,
        })
        .where(eq(subscriptions.id, user.existingSubId));
    }

    // Add old feed ID to the existing subscription's subscription_feeds
    await db
      .insert(subscriptionFeeds)
      .values({
        subscriptionId: user.existingSubId,
        feedId: oldFeed.id,
        userId: user.userId,
      })
      .onConflictDoNothing();
  }

  // Batch insert: For users without existing subscriptions, create new ones
  if (usersWithoutExisting.length > 0) {
    const newSubscriptions = usersWithoutExisting.map((userId) => ({
      id: generateUuidv7(),
      userId,
      feedId: newFeed.id,
      subscribedAt: now,
      createdAt: now,
      updatedAt: now,
    }));

    await db.insert(subscriptions).values(newSubscriptions);

    // Add subscription_feeds entries for both new feed and old feed
    const sfEntries = newSubscriptions.flatMap((sub) => [
      { subscriptionId: sub.id, feedId: newFeed.id, userId: sub.userId },
      { subscriptionId: sub.id, feedId: oldFeed.id, userId: sub.userId },
    ]);
    await db.insert(subscriptionFeeds).values(sfEntries).onConflictDoNothing();

    // Ensure a job exists for the new feed (will be claimed via data-driven eligibility)
    await ensureFeedJob(newFeed.id);
  }

  // Batch update: Unsubscribe all old subscriptions at once
  await db
    .update(subscriptions)
    .set({
      unsubscribedAt: now,
      updatedAt: now,
    })
    .where(inArray(subscriptions.id, oldSubIds));

  logger.debug("Migrated subscriptions", {
    oldFeedId: oldFeed.id,
    newFeedId: newFeed.id,
    withExisting: usersWithExisting.length,
    newSubscriptions: usersWithoutExisting.length,
  });

  // Note: The old feed's job will naturally stop being claimed since it has no active
  // subscribers. In the data-driven model, we don't need to explicitly disable it.
}

/**
 * How often the WebSub renewal job runs.
 *
 * This must be short relative to the shortest lease we want to keep alive: a
 * lease can only be renewed on a run that falls within its renewal window, so a
 * daily cadence silently lets sub-24h leases lapse until the next run. Running
 * hourly keeps any lease down to ~1h alive.
 */
const WEBSUB_RENEWAL_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

/**
 * How far ahead of expiry we renew, in hours.
 *
 * Kept just above the run interval so every lease is renewed on the run before
 * it would expire, while long leases are left untouched until near their own
 * expiry (no per-run re-subscribe spam).
 */
const WEBSUB_RENEWAL_THRESHOLD_HOURS = 2;

/**
 * Handler for renew_websub jobs.
 * Renews WebSub subscriptions that are expiring soon.
 *
 * Runs hourly (see WEBSUB_RENEWAL_INTERVAL_MS) and renews active subscriptions
 * expiring within WEBSUB_RENEWAL_THRESHOLD_HOURS. The frequent cadence + short
 * threshold keeps short leases alive without re-subscribing long leases every
 * run.
 *
 * @param _payload - The job payload (empty for this job type)
 * @returns Job handler result with next run time
 */
export async function handleRenewWebsub(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _payload: JobPayloads["renew_websub"]
): Promise<JobHandlerResult> {
  logger.info("Starting WebSub subscription renewal check");

  const result = await renewExpiringSubscriptions(WEBSUB_RENEWAL_THRESHOLD_HOURS);

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

  // Schedule the next check one interval out.
  const nextRunAt = new Date(Date.now() + WEBSUB_RENEWAL_INTERVAL_MS);

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

/** How often the feed fetch health check runs. */
const FEED_HEALTH_CHECK_INTERVAL_MS = 15 * 60 * 1000;

/**
 * Handler for monitor_feed_health jobs (singleton, runs every 15 minutes).
 *
 * Checks the invariant "at least one feed fetched successfully recently"
 * (see src/server/feed/health.ts) and:
 * - Pings the configured healthchecks.io check (FEED_HEALTH_HEARTBEAT_URL):
 *   a success ping when healthy, a `/fail` ping with an explanatory body when
 *   not. This is the feed-fetch *quality* signal; the worker process's own
 *   liveness is a separate check (WORKER_HEARTBEAT_URL, see scripts/worker.ts),
 *   so "feeds are failing" stays distinguishable from "worker is dead".
 * - Updates the feed health Prometheus gauges.
 *
 * No alert state is kept here: healthchecks.io de-duplicates notifications and
 * sends its own recovery ("up") email, so the job just reports status each run.
 */
export async function handleMonitorFeedHealth(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _payload: JobPayloads["monitor_feed_health"]
): Promise<JobHandlerResult> {
  const now = new Date();
  const snapshot = await getFeedFetchHealthSnapshot();
  const evaluation = evaluateFeedFetchHealth(
    snapshot,
    now,
    feedHealthConfig.maxSuccessAgeMinutes * 60 * 1000
  );

  updateFeedHealthMetrics(
    evaluation.lastSuccessAgeMs !== null ? evaluation.lastSuccessAgeMs / 1000 : null,
    snapshot.failingFeedCount
  );

  if (evaluation.status === "unhealthy") {
    logger.warn("Feed fetch health check failed", {
      reason: evaluation.reason,
      lastSuccessfulFetchAt: snapshot.lastSuccessfulFetchAt?.toISOString(),
      failingFeedCount: snapshot.failingFeedCount,
      pollableFeedCount: snapshot.pollableFeedCount,
      sampleError: snapshot.sampleError,
    });
  }

  if (feedHealthConfig.heartbeatUrl) {
    await pingHealthcheck(feedHealthConfig.heartbeatUrl, {
      signal: evaluation.status === "healthy" ? "success" : "fail",
      body: buildFeedHealthPingBody(snapshot, evaluation),
    });
  }

  return {
    success: true,
    nextRunAt: new Date(now.getTime() + FEED_HEALTH_CHECK_INTERVAL_MS),
    metadata: {
      status: evaluation.status,
      reason: evaluation.reason,
      lastSuccessAgeMs: evaluation.lastSuccessAgeMs ?? undefined,
      failingFeedCount: snapshot.failingFeedCount,
      pollableFeedCount: snapshot.pollableFeedCount,
    },
  };
}

/** How often the retention cleanup runs. */
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Handler for cleanup jobs (singleton, runs daily).
 *
 * Deletes rows that expire but were never deleted anywhere (issue #953):
 * expired sessions, expired OAuth authorization codes / access tokens /
 * refresh tokens, long-revoked credentials, orphaned Dynamic Client
 * Registration clients (issue #975), and parked one-time process_opml_import
 * jobs. See src/server/services/retention.ts.
 */
export async function handleCleanup(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _payload: JobPayloads["cleanup"]
): Promise<JobHandlerResult> {
  const now = new Date();
  const deleted = await runRetentionCleanup(db);

  logger.info("Retention cleanup completed", { ...deleted });

  return {
    success: true,
    nextRunAt: new Date(now.getTime() + CLEANUP_INTERVAL_MS),
    metadata: { ...deleted },
  };
}

/**
 * Number of entries re-sanitized per `resanitize_entries` batch. Deliberately
 * small so the sweep never monopolizes a worker or the database — it yields
 * between batches and, as a singleton, is claimed only after real work.
 */
export const RESANITIZE_BATCH_SIZE = 10;

/**
 * Delay before the next batch while a re-sanitization pass is still in progress.
 * Short enough to make steady progress, long enough to stay a gentle background
 * trickle rather than a tight loop.
 */
const RESANITIZE_BATCH_INTERVAL_MS = 5 * 1000;

/**
 * Delay before the next run once the corpus is fully caught up (a batch found
 * nothing stale). The job then just idles, and the next tick re-checks — one
 * cheap indexed lookup that returns immediately — so it notices a future
 * SANITIZER_VERSION bump (a deploy) and resumes.
 */
const RESANITIZE_IDLE_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Handler for resanitize_entries jobs (singleton, stateless).
 *
 * Re-derives the persisted `entries.*_sanitized` columns for entries left stale
 * by a `SANITIZER_VERSION` bump, one small batch at a time. Recent entries heal
 * first (the sweep orders by highest stale version then newest id, which right
 * after a bump is just newest-first; see `resanitizeStaleEntries`), matching the
 * read-path self-heal
 * (`resolveSanitizedFamily`) that already fixes any entry a user opens — this
 * sweeper covers the long tail nobody reads so the whole corpus converges
 * without a migration.
 *
 * No cross-run state: healed rows advance to the current version and drop out of
 * the stale range, so each run's batch resumes where the last left off. A bump
 * needs nothing here — the next scheduled run simply finds newly-stale rows.
 */
export async function handleResanitizeEntries(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _payload: JobPayloads["resanitize_entries"]
): Promise<JobHandlerResult> {
  const result = await resanitizeStaleEntries(db, { limit: RESANITIZE_BATCH_SIZE });

  // Nothing stale: the corpus is caught up for the current version. Idle until
  // the next tick (which is cheap — the indexed lookup returns immediately).
  // Space the interval from *after* the batch so a slow batch doesn't schedule
  // the next run in the past (back-to-back batches).
  const caughtUp = result.processed === 0;
  const intervalMs = caughtUp ? RESANITIZE_IDLE_INTERVAL_MS : RESANITIZE_BATCH_INTERVAL_MS;

  return {
    success: true,
    nextRunAt: new Date(Date.now() + intervalMs),
    metadata: {
      status: caughtUp ? "idle" : "in_progress",
      version: SANITIZER_VERSION,
      processed: result.processed,
      contentResanitized: result.contentResanitized,
      fullContentResanitized: result.fullContentResanitized,
      failed: result.failed,
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

    // Collect all unique tag names from categories in the import
    const tagNames = new Set<string>();
    for (const feed of importRecord.feedsData) {
      if (feed.category) {
        for (const categoryName of feed.category) {
          tagNames.add(categoryName);
        }
      }
    }

    // Get or create tags for each unique category name
    // Store full tag info for subscription_created events
    const tagNameToInfo = new Map<string, { id: string; name: string; color: string | null }>();
    if (tagNames.size > 0) {
      // Get existing tags for this user
      const existingTags = await db
        .select({ id: tags.id, name: tags.name, color: tags.color })
        .from(tags)
        .where(eq(tags.userId, userId));

      for (const existingTag of existingTags) {
        if (tagNames.has(existingTag.name)) {
          tagNameToInfo.set(existingTag.name, {
            id: existingTag.id,
            name: existingTag.name,
            color: existingTag.color,
          });
        }
      }

      // Batch create tags that don't exist (avoids N+1 queries)
      const now = new Date();
      const tagsToCreate = Array.from(tagNames)
        .filter((tagName) => !tagNameToInfo.has(tagName))
        .map((tagName) => ({
          id: generateUuidv7(),
          userId,
          name: tagName,
          createdAt: now,
        }));

      if (tagsToCreate.length > 0) {
        await db.insert(tags).values(tagsToCreate);
        for (const tag of tagsToCreate) {
          tagNameToInfo.set(tag.name, { id: tag.id, name: tag.name, color: null });
        }
        logger.debug("OPML import: created tags", {
          count: tagsToCreate.length,
          tagNames: tagsToCreate.map((t) => t.name),
          userId,
        });
      }
    }

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
        const subscriptionResult = await createSubscription(db, userId, {
          url: feedUrl,
          title: feedTitle,
          siteUrl: opmlFeed.htmlUrl ?? null,
        });

        const actualSubscriptionId = subscriptionResult.subscriptionId;
        const feedId = subscriptionResult.feed.id;

        // Associate subscription with tags from categories
        if (opmlFeed.category && opmlFeed.category.length > 0) {
          const tagInfos = opmlFeed.category
            .map((categoryName) => tagNameToInfo.get(categoryName))
            .filter(
              (info): info is { id: string; name: string; color: string | null } =>
                info !== undefined
            );

          if (tagInfos.length > 0) {
            // Delete any existing subscription_tags (in case of reactivation)
            await db
              .delete(subscriptionTags)
              .where(eq(subscriptionTags.subscriptionId, actualSubscriptionId));

            // Insert new subscription_tags entries
            const tagNow = new Date();
            await db.insert(subscriptionTags).values(
              tagInfos.map((tagInfo) => ({
                subscriptionId: actualSubscriptionId,
                tagId: tagInfo.id,
                createdAt: tagNow,
              }))
            );

            // Publish update event so the UI picks up the tags
            publishSubscriptionUpdated(
              userId,
              actualSubscriptionId,
              tagNow,
              tagInfos,
              null // no custom title
            ).catch((err) => {
              logger.error("Failed to publish subscription_updated event", {
                err,
                userId,
                feedId,
              });
            });

            logger.debug("OPML import: associated subscription with tags", {
              subscriptionId: actualSubscriptionId,
              tagIds: tagInfos.map((t) => t.id),
              feedUrl,
            });
          }
        }

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

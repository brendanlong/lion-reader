/**
 * Tracks and applies permanent feed redirects for the feed-fetch pipeline: a
 * redirect is tracked for `REDIRECT_WAIT_PERIOD_MS` before the feed's URL
 * changes, or its subscriptions merge into the feed already at the target.
 */

import { eq } from "drizzle-orm";
import { db } from "../db";
import { feeds, type Feed } from "../db/schema";
import { migrateSubscriptionsToExistingFeed } from "../services/subscribe";
import { logger } from "@/lib/logger";
import { isHttpToHttpsUpgrade, REDIRECT_WAIT_PERIOD_MS } from "./redirect-utils";

interface RedirectOutcome {
  /** Whether the redirect was applied (the feed URL changed or it was merged). */
  applied: boolean;
  metadata: Record<string, unknown>;
  /** When to fetch the feed next, set when the redirect was applied. */
  nextRunAt?: Date;
}

/**
 * Clears redirect tracking fields on a feed.
 *
 * @param feedId - The feed ID
 * @param now - Current timestamp
 */
export async function clearRedirectTracking(feedId: string, now: Date): Promise<void> {
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
 * - Returns whether it was applied and the feed URL changed (`RedirectOutcome`)
 *
 * @param feed - The feed record
 * @param redirectUrl - The permanent redirect URL
 * @param now - Current timestamp
 * @returns Object with applied flag and metadata
 */
export async function handlePermanentRedirect(
  feed: Feed,
  redirectUrl: string,
  now: Date
): Promise<RedirectOutcome> {
  // Check for HTTP -> HTTPS upgrade (apply immediately)
  if (feed.url && isHttpToHttpsUpgrade(feed.url, redirectUrl)) {
    logger.info("Applying HTTP to HTTPS redirect immediately", {
      feedId: feed.id,
      oldUrl: feed.url,
      newUrl: redirectUrl,
    });

    return applyRedirectMigration(feed, redirectUrl, now);
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

  // New redirect, or the destination changed from the one we were tracking:
  // (re)start tracking it
  const tracking = feed.redirectUrl && feed.redirectUrl !== redirectUrl ? "reset" : "started";
  logger.info(
    tracking === "reset"
      ? "Redirect URL changed, resetting tracking"
      : "Starting redirect tracking",
    {
      feedId: feed.id,
      feedUrl: feed.url,
      previousRedirectUrl: feed.redirectUrl,
      redirectUrl,
    }
  );

  await db
    .update(feeds)
    .set({ redirectUrl, redirectFirstSeenAt: now, updatedAt: now })
    .where(eq(feeds.id, feed.id));

  return {
    applied: false,
    metadata: { redirectTracking: tracking, redirectUrl },
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
export async function applyRedirectMigration(
  feed: Feed,
  redirectUrl: string,
  now: Date
): Promise<RedirectOutcome> {
  // Check if a feed already exists at the redirect URL
  const [existingFeedAtRedirectUrl] = await db
    .select()
    .from(feeds)
    .where(eq(feeds.url, redirectUrl))
    .limit(1);

  if (existingFeedAtRedirectUrl) {
    // Feed exists at redirect URL - migrate subscriptions
    await migrateSubscriptionsToExistingFeed(db, feed, existingFeedAtRedirectUrl);

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

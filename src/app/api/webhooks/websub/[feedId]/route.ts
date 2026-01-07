/**
 * WebSub Callback Endpoint
 *
 * Handles WebSub (PubSubHubbub) callbacks from hubs:
 * - GET: Verification challenges when subscribing/unsubscribing
 * - POST: Content notifications when feeds are updated
 *
 * URL format: /api/webhooks/websub/:feedId
 */

import { eq } from "drizzle-orm";
import { db } from "@/server/db";
import { feeds } from "@/server/db/schema";
import {
  handleVerificationChallenge,
  verifyHmacSignature,
  parseFeed,
  processEntries,
} from "@/server/feed";
import { updateFeedJobNextRun } from "@/server/jobs/queue";
import { trackWebsubNotificationReceived } from "@/server/metrics/metrics";
import { logger } from "@/lib/logger";
import { isValidUuid } from "@/lib/uuidv7";

/**
 * Longer interval for backup polling when WebSub is active.
 * WebSub should deliver updates in real-time, so we use a 4-hour backup interval
 * instead of the normal 15-minute interval.
 */
const WEBSUB_BACKUP_POLL_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours

/**
 * Route segment config for Next.js
 */
export const dynamic = "force-dynamic";

/**
 * GET /api/webhooks/websub/:feedId
 *
 * Handles WebSub verification challenges.
 * The hub sends a GET request with query parameters to verify
 * that we requested the subscription.
 *
 * Query parameters:
 * - hub.mode: "subscribe" or "unsubscribe"
 * - hub.topic: The feed URL (topic) we subscribed to
 * - hub.challenge: A random string we must echo back
 * - hub.lease_seconds: (optional) How long the subscription lasts
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ feedId: string }> }
): Promise<Response> {
  const { feedId } = await params;

  // Validate feedId format
  if (!isValidUuid(feedId)) {
    logger.warn("WebSub verification with invalid feedId", { feedId });
    return new Response("Invalid feed ID", { status: 400 });
  }

  // Extract query parameters
  const url = new URL(request.url);
  const mode = url.searchParams.get("hub.mode");
  const topic = url.searchParams.get("hub.topic");
  const challenge = url.searchParams.get("hub.challenge");
  const leaseSeconds = url.searchParams.get("hub.lease_seconds");

  logger.debug("WebSub verification request received", {
    feedId,
    mode,
    topic,
    challenge: challenge ? "[present]" : "[missing]",
    leaseSeconds,
  });

  // Handle the verification
  const result = await handleVerificationChallenge(feedId, {
    mode,
    topic,
    challenge,
    leaseSeconds,
  });

  if (result.success && result.challenge) {
    // Return the challenge to confirm the subscription
    return new Response(result.challenge, {
      status: 200,
      headers: {
        "Content-Type": "text/plain",
      },
    });
  }

  // Verification failed - return 404 to reject the subscription
  logger.warn("WebSub verification failed", {
    feedId,
    error: result.error,
  });

  return new Response(result.error || "Verification failed", {
    status: 404,
    headers: {
      "Content-Type": "text/plain",
    },
  });
}

/**
 * POST /api/webhooks/websub/:feedId
 *
 * Handles WebSub content notifications.
 * The hub sends a POST request with the feed content when it's updated.
 *
 * Headers:
 * - Content-Type: The feed format (application/rss+xml, application/atom+xml, etc.)
 * - X-Hub-Signature: HMAC signature for verification (e.g., "sha256=abc123...")
 *
 * Body: The feed content (RSS/Atom/JSON)
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ feedId: string }> }
): Promise<Response> {
  const { feedId } = await params;

  // Validate feedId format
  if (!isValidUuid(feedId)) {
    logger.warn("WebSub notification with invalid feedId", { feedId });
    return new Response("Invalid feed ID", { status: 400 });
  }

  // Get the raw body for signature verification
  const bodyText = await request.text();

  // Verify HMAC signature
  const signature = request.headers.get("x-hub-signature");
  const isValid = await verifyHmacSignature(feedId, signature, bodyText);

  if (!isValid) {
    logger.warn("WebSub notification with invalid signature", {
      feedId,
      signature: signature ? "[present]" : "[missing]",
    });
    return new Response("Invalid signature", { status: 403 });
  }

  // Check if feed exists
  const [feed] = await db.select().from(feeds).where(eq(feeds.id, feedId)).limit(1);

  if (!feed) {
    logger.warn("WebSub notification for unknown feed", { feedId });
    return new Response("Feed not found", { status: 404 });
  }

  // Track WebSub notification received metric
  trackWebsubNotificationReceived();

  // Parse the pushed feed content
  let parsedFeed;
  try {
    parsedFeed = parseFeed(bodyText);
  } catch (error) {
    logger.warn("WebSub notification with invalid feed content", {
      feedId,
      error: error instanceof Error ? error.message : "Unknown error",
    });
    // Return 200 to avoid the hub retrying with bad content
    return new Response("OK", { status: 200 });
  }

  // Process entries from the pushed content
  const now = new Date();
  try {
    const result = await processEntries(feedId, feed.type, parsedFeed, { fetchedAt: now });

    // Update feed timestamps
    await db
      .update(feeds)
      .set({
        lastFetchedAt: now,
        updatedAt: now,
        // Update metadata if available
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

    // Schedule backup polling with a longer interval since WebSub is active.
    // This ensures we still get updates even if WebSub stops working.
    await scheduleBackupPoll(feedId);
  } catch (error) {
    logger.error("WebSub notification processing failed", {
      feedId,
      error: error instanceof Error ? error.message : "Unknown error",
    });
    // Return 200 to acknowledge receipt even if processing failed
    // The hub doesn't need to retry - we have the content

    // Still schedule backup polling in case of errors
    await scheduleBackupPoll(feedId);
  }

  // Always return 200 to acknowledge receipt
  return new Response("OK", { status: 200 });
}

/**
 * Schedules a backup polling job for a feed.
 * Uses a longer interval than normal since WebSub is active.
 * Updates the existing job's next_run_at rather than creating a new job.
 */
async function scheduleBackupPoll(feedId: string): Promise<void> {
  const nextRunAt = new Date(Date.now() + WEBSUB_BACKUP_POLL_INTERVAL_MS);

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

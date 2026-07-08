/**
 * WebSub Callback Endpoint (per-subscription)
 *
 * Handles WebSub (PubSubHubbub) callbacks from hubs:
 * - GET: Verification challenges when subscribing/unsubscribing
 * - POST: Content notifications when feeds are updated
 *
 * URL format: /api/webhooks/websub/:feedId/:subscriptionId
 *
 * Including the subscription ID makes each callback resolve to exactly one
 * subscription row, so a feed with multiple subscription rows (e.g. after
 * switching hubs) is never ambiguous. The legacy per-feed route ([feedId]) still
 * serves subscriptions registered before this URL shape existed.
 */

import { eq } from "drizzle-orm";
import { db } from "@/server/db";
import { feeds } from "@/server/db/schema";
import { handleVerificationChallenge, verifyHmacSignature } from "@/server/feed/websub";
import { ingestWebsubNotification } from "@/server/feed/websub-notification";
import { ContentTooLargeError, readRequestTextWithSizeLimit } from "@/server/http/fetch";
import { usageLimitsConfig } from "@/server/config/env";
import { logger } from "@/lib/logger";
import { isValidUuid } from "@/lib/uuidv7";

/**
 * Route segment config for Next.js
 */
export const dynamic = "force-dynamic";

/**
 * GET /api/webhooks/websub/:feedId/:subscriptionId
 *
 * Handles WebSub verification challenges.
 *
 * Query parameters:
 * - hub.mode: "subscribe" or "unsubscribe"
 * - hub.topic: The feed URL (topic) we subscribed to
 * - hub.challenge: A random string we must echo back
 * - hub.lease_seconds: (optional) How long the subscription lasts
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ feedId: string; subscriptionId: string }> }
): Promise<Response> {
  const { feedId, subscriptionId } = await params;

  if (!isValidUuid(feedId) || !isValidUuid(subscriptionId)) {
    logger.warn("WebSub verification with invalid IDs", { feedId, subscriptionId });
    return new Response("Invalid callback URL", { status: 400 });
  }

  const url = new URL(request.url);
  const params_ = {
    mode: url.searchParams.get("hub.mode"),
    topic: url.searchParams.get("hub.topic"),
    challenge: url.searchParams.get("hub.challenge"),
    leaseSeconds: url.searchParams.get("hub.lease_seconds"),
  };

  logger.debug("WebSub verification request received", {
    feedId,
    subscriptionId,
    mode: params_.mode,
    topic: params_.topic,
    challenge: params_.challenge ? "[present]" : "[missing]",
    leaseSeconds: params_.leaseSeconds,
  });

  const result = await handleVerificationChallenge(feedId, subscriptionId, params_);

  if (result.success && result.challenge) {
    return new Response(result.challenge, {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    });
  }

  logger.warn("WebSub verification failed", { feedId, subscriptionId, error: result.error });
  return new Response(result.error || "Verification failed", {
    status: 404,
    headers: { "Content-Type": "text/plain" },
  });
}

/**
 * POST /api/webhooks/websub/:feedId/:subscriptionId
 *
 * Handles WebSub content notifications.
 *
 * Headers:
 * - Content-Type: The feed format (application/rss+xml, application/atom+xml, etc.)
 * - X-Hub-Signature: HMAC signature for verification (e.g., "sha256=abc123...")
 *
 * Body: The feed content (RSS/Atom/JSON)
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ feedId: string; subscriptionId: string }> }
): Promise<Response> {
  const { feedId, subscriptionId } = await params;

  logger.info("WebSub notification received", {
    feedId,
    subscriptionId,
    contentType: request.headers.get("content-type"),
    hasSignature: !!request.headers.get("x-hub-signature"),
  });

  if (!isValidUuid(feedId) || !isValidUuid(subscriptionId)) {
    logger.warn("WebSub notification with invalid IDs", { feedId, subscriptionId });
    return new Response("Invalid callback URL", { status: 400 });
  }

  // Bound the body BEFORE buffering + HMAC: anyone who learns a callback URL
  // (they leak via hub dashboards/proxies/logs) could otherwise POST an
  // arbitrarily large payload to exhaust memory.
  let bodyText: string;
  try {
    bodyText = await readRequestTextWithSizeLimit(request, usageLimitsConfig.maxFeedSizeBytes);
  } catch (error) {
    if (error instanceof ContentTooLargeError) {
      logger.warn("WebSub notification body too large", { feedId, subscriptionId });
      return new Response("Payload too large", { status: 413 });
    }
    throw error;
  }

  const signature = request.headers.get("x-hub-signature");
  const isValid = await verifyHmacSignature(feedId, subscriptionId, signature, bodyText);

  if (!isValid) {
    logger.warn("WebSub notification with invalid signature", {
      feedId,
      subscriptionId,
      signature: signature ? "[present]" : "[missing]",
    });
    return new Response("Invalid signature", { status: 403 });
  }

  const [feed] = await db.select().from(feeds).where(eq(feeds.id, feedId)).limit(1);
  if (!feed) {
    logger.warn("WebSub notification for unknown feed", { feedId, subscriptionId });
    return new Response("Feed not found", { status: 404 });
  }

  await ingestWebsubNotification(feed, bodyText);

  // Always return 200 to acknowledge receipt
  return new Response("OK", { status: 200 });
}

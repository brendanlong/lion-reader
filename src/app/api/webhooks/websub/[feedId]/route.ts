/**
 * Legacy WebSub Callback Endpoint (per-feed)
 *
 * Handles WebSub (PubSubHubbub) callbacks that were registered with the old
 * per-feed callback URL, before per-subscription callback URLs were introduced:
 * - GET: Verification challenges when subscribing/unsubscribing
 * - POST: Content notifications when feeds are updated
 *
 * URL format: /api/webhooks/websub/:feedId
 *
 * New and renewed subscriptions register /api/webhooks/websub/:feedId/:subscriptionId
 * (see the [subscriptionId] route). This route stays until every subscription has
 * renewed onto the per-subscription URL, then it can be removed.
 */

import { eq } from "drizzle-orm";
import { db } from "@/server/db";
import { feeds } from "@/server/db/schema";
import { handleVerificationChallengeByFeed, verifyHmacSignatureByFeed } from "@/server/feed/websub";
import { ingestWebsubNotification } from "@/server/feed/websub-notification";
import { ContentTooLargeError, readRequestBufferWithSizeLimit } from "@/server/http/fetch";
import { usageLimitsConfig } from "@/server/config/env";
import { logger } from "@/lib/logger";
import { isValidUuid } from "@/lib/uuidv7";

/**
 * Route segment config for Next.js
 */
export const dynamic = "force-dynamic";

/**
 * GET /api/webhooks/websub/:feedId
 *
 * Handles WebSub verification challenges for legacy per-feed subscriptions.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ feedId: string }> }
): Promise<Response> {
  const { feedId } = await params;

  if (!isValidUuid(feedId)) {
    logger.warn("WebSub verification with invalid feedId", { feedId });
    return new Response("Invalid feed ID", { status: 400 });
  }

  const url = new URL(request.url);
  const params_ = {
    mode: url.searchParams.get("hub.mode"),
    topic: url.searchParams.get("hub.topic"),
    challenge: url.searchParams.get("hub.challenge"),
    leaseSeconds: url.searchParams.get("hub.lease_seconds"),
  };

  logger.debug("WebSub verification request received (legacy per-feed)", {
    feedId,
    mode: params_.mode,
    topic: params_.topic,
    challenge: params_.challenge ? "[present]" : "[missing]",
    leaseSeconds: params_.leaseSeconds,
  });

  const result = await handleVerificationChallengeByFeed(feedId, params_);

  if (result.success && result.challenge) {
    return new Response(result.challenge, {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    });
  }

  logger.warn("WebSub verification failed", { feedId, error: result.error });
  return new Response(result.error || "Verification failed", {
    status: 404,
    headers: { "Content-Type": "text/plain" },
  });
}

/**
 * POST /api/webhooks/websub/:feedId
 *
 * Handles WebSub content notifications for legacy per-feed subscriptions.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ feedId: string }> }
): Promise<Response> {
  const { feedId } = await params;

  logger.info("WebSub notification received (legacy per-feed)", {
    feedId,
    contentType: request.headers.get("content-type"),
    hasSignature: !!request.headers.get("x-hub-signature"),
  });

  if (!isValidUuid(feedId)) {
    logger.warn("WebSub notification with invalid feedId", { feedId });
    return new Response("Invalid feed ID", { status: 400 });
  }

  // Bound the body BEFORE buffering + HMAC (see the per-subscription route).
  let bodyBuffer: Buffer;
  try {
    bodyBuffer = await readRequestBufferWithSizeLimit(request, usageLimitsConfig.maxFeedSizeBytes);
  } catch (error) {
    if (error instanceof ContentTooLargeError) {
      logger.warn("WebSub notification body too large", { feedId });
      return new Response("Payload too large", { status: 413 });
    }
    throw error;
  }

  const signature = request.headers.get("x-hub-signature");
  // Verify over the raw bytes the hub signed, not a decoded/re-encoded string.
  const isValid = await verifyHmacSignatureByFeed(feedId, signature, bodyBuffer);

  if (!isValid) {
    logger.warn("WebSub notification with invalid signature", {
      feedId,
      signature: signature ? "[present]" : "[missing]",
    });
    return new Response("Invalid signature", { status: 403 });
  }

  const [feed] = await db.select().from(feeds).where(eq(feeds.id, feedId)).limit(1);
  if (!feed) {
    logger.warn("WebSub notification for unknown feed", { feedId });
    return new Response("Feed not found", { status: 404 });
  }

  await ingestWebsubNotification(feed, bodyBuffer.toString());

  // Always return 200 to acknowledge receipt
  return new Response("OK", { status: 200 });
}

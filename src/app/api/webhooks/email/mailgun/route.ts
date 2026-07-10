/**
 * Mailgun Email Webhook Endpoint
 *
 * Receives inbound emails from Mailgun's forward() action and processes them
 * as newsletter entries. This endpoint:
 * - Verifies the webhook signature using HMAC-SHA256
 * - Parses the Mailgun form-encoded format into a normalized format
 * - Processes the email to create feed entries
 *
 * Response codes:
 * - 200: Success - email accepted (or a deliberate, durable rejection)
 * - 406: Rejected - invalid signature or missing data (Mailgun won't retry)
 * - 500: Transient processing failure - Mailgun WILL retry (same signed triple)
 */

import { createHmac, timingSafeEqual } from "crypto";
import { processInboundEmail, type InboundEmail } from "@/server/email/process-inbound";
import { ingestConfig } from "@/server/config/env";
import { getRedisClient } from "@/server/redis";
import { logger } from "@/lib/logger";
import { parseFromAddress } from "@/server/email/parse-utils";

/**
 * Route segment config for Next.js
 */
export const dynamic = "force-dynamic";

/**
 * How far a Mailgun webhook timestamp may be from now (seconds) before we treat
 * the request as a replay. Mailgun's signature only covers `(timestamp, token)`
 * — NOT the body — so a captured valid triple could otherwise be replayed
 * forever with an arbitrary body. This window bounds that.
 *
 * The window MUST cover Mailgun's full delivery-retry horizon (~8h of backoff:
 * 10m, 10m, 15m, 30m, 1h, 2h, 4h), because retries reuse the *original*
 * `(timestamp, token, signature)` triple — the timestamp is the first-attempt
 * send time, not per-attempt. With a narrow window (e.g. 15 min), any outage
 * longer than the window would 406 every later retry of mail sent during it,
 * and a 406 tells Mailgun to stop retrying — converting a transient outage into
 * permanent, silent mail loss. Within the window, actual replays are still
 * blocked by the Redis nonce below whenever Redis is up; the wide window only
 * weakens things in the (Redis down ∧ attacker holds a captured triple) case,
 * where Message-ID dedup still bounds the damage.
 */
const MAILGUN_TIMESTAMP_TOLERANCE_SECONDS = 9 * 60 * 60;

/**
 * Checks that the Mailgun webhook timestamp is within the freshness window.
 */
function isTimestampFresh(timestamp: string): boolean {
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) {
    return false;
  }
  const nowSeconds = Date.now() / 1000;
  return Math.abs(nowSeconds - ts) <= MAILGUN_TIMESTAMP_TOLERANCE_SECONDS;
}

function webhookNonceKey(token: string): string {
  return `mailgun:webhook:nonce:${token}`;
}

/**
 * Returns true if this webhook token has already been marked seen — i.e. a
 * previously-*completed* request replayed. Mailgun reuses the same
 * `(timestamp, token, signature)` on every delivery retry, so the nonce is
 * marked only *after* a request durably completes ({@link markWebhookTokenSeen}),
 * never up front: that way a legitimate retry after a mid-processing crash
 * (which never marked the token) still reprocesses instead of being dropped,
 * while a genuine replay of an already-handled event is rejected. When Redis is
 * unavailable we can't dedup, so we treat the token as unseen — timestamp
 * freshness and downstream Message-ID dedup still bound replays.
 */
async function wasWebhookTokenSeen(token: string): Promise<boolean> {
  const redis = getRedisClient();
  if (!redis) {
    return false;
  }
  try {
    return (await redis.exists(webhookNonceKey(token))) === 1;
  } catch (error) {
    // A Redis hiccup must not drop legitimate mail; treat as unseen.
    logger.warn("Mailgun webhook nonce lookup failed; treating as unseen", {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * Marks the webhook token as seen once its event has been durably handled, so
 * later retries/replays of the same token are rejected by
 * {@link wasWebhookTokenSeen}. The TTL matches the freshness window (plus a small
 * buffer): a replay older than that is already rejected by the timestamp check.
 */
async function markWebhookTokenSeen(token: string): Promise<void> {
  const redis = getRedisClient();
  if (!redis) {
    return;
  }
  try {
    await redis.set(webhookNonceKey(token), "1", "EX", MAILGUN_TIMESTAMP_TOLERANCE_SECONDS + 60);
  } catch (error) {
    logger.warn("Mailgun webhook nonce mark failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Verifies the Mailgun webhook signature.
 * Mailgun signs requests with HMAC-SHA256(timestamp + token, signing_key).
 *
 * @param timestamp - Unix timestamp from the request
 * @param token - Random token from the request
 * @param signature - Expected signature from the request
 * @param signingKey - Mailgun webhook signing key
 * @returns Whether the signature is valid
 */
function verifySignature(
  timestamp: string,
  token: string,
  signature: string,
  signingKey: string
): boolean {
  const encodedToken = createHmac("sha256", signingKey)
    .update(timestamp + token)
    .digest("hex");

  // Use timing-safe comparison to prevent timing attacks
  try {
    return timingSafeEqual(Buffer.from(encodedToken), Buffer.from(signature));
  } catch {
    // Buffers of different lengths will throw
    return false;
  }
}

/**
 * Extracts a header value from Mailgun's message-headers JSON.
 * The format is an array of [header-name, header-value] tuples.
 *
 * @param headersJson - JSON string of message headers
 * @param headerName - Header name to find (case-insensitive)
 * @returns Header value or undefined
 */
function getHeaderFromJson(headersJson: string | null, headerName: string): string | undefined {
  if (!headersJson) return undefined;

  try {
    const headers = JSON.parse(headersJson) as Array<[string, string]>;
    const lowerName = headerName.toLowerCase();

    for (const [name, value] of headers) {
      if (name.toLowerCase() === lowerName) {
        return value;
      }
    }
  } catch {
    logger.warn("Failed to parse message-headers JSON", { headersJson });
  }

  return undefined;
}

/**
 * Extracts Message-ID from headers.
 * Falls back to generating one if not found.
 *
 * @param headersJson - JSON string of message headers
 * @param from - Sender address for fallback generation
 * @returns Message-ID string
 */
function extractMessageId(headersJson: string | null, from: string): string {
  const messageId = getHeaderFromJson(headersJson, "Message-ID");

  if (messageId) {
    // Strip angle brackets if present
    return messageId.replace(/^<|>$/g, "");
  }

  // Generate a fallback Message-ID using timestamp and from address
  const timestamp = Date.now();
  return `generated-${timestamp}-${from}`;
}

/**
 * Converts a Mailgun form payload to our normalized InboundEmail format.
 *
 * @param formData - The parsed form data
 * @returns Normalized InboundEmail
 */
function parseMailgunEmail(formData: FormData): InboundEmail {
  const fromRaw = formData.get("from") as string;
  const from = parseFromAddress(fromRaw);
  const headersJson = formData.get("message-headers") as string | null;
  const messageId = extractMessageId(headersJson, from.address);

  return {
    to: formData.get("recipient") as string,
    from,
    subject: (formData.get("subject") as string) ?? "",
    messageId,
    html: (formData.get("body-html") as string) || undefined,
    text: (formData.get("body-plain") as string) || undefined,
    headers: {
      listUnsubscribe: getHeaderFromJson(headersJson, "List-Unsubscribe"),
      listUnsubscribePost: getHeaderFromJson(headersJson, "List-Unsubscribe-Post"),
    },
    // Mailgun doesn't provide spam scores in the parsed format
    spamScore: undefined,
    isSpam: undefined,
  };
}

/**
 * POST /api/webhooks/email/mailgun
 *
 * Handles incoming email webhooks from Mailgun's forward() action.
 * Verifies the signature and processes the email.
 *
 * Returns:
 * - 200 OK: Email processed successfully (or durably rejected)
 * - 406 Not Acceptable: Invalid signature or missing required data (no retry)
 * - 500 Internal Server Error: Transient processing failure (Mailgun retries)
 */
export async function POST(request: Request): Promise<Response> {
  // 1. Check webhook signing key is configured
  const signingKey = ingestConfig.mailgunWebhookSigningKey;

  if (!signingKey) {
    logger.error("Mailgun webhook received but MAILGUN_WEBHOOK_SIGNING_KEY is not configured");
    // Return 406 to tell Mailgun not to retry - configuration error
    return new Response("Not Configured", { status: 406 });
  }

  // 2. Parse the form data
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch (error) {
    logger.error("Failed to parse Mailgun webhook form data", {
      error: error instanceof Error ? error.message : String(error),
    });
    return new Response("Invalid Form Data", { status: 406 });
  }

  // 3. Verify signature
  const timestamp = formData.get("timestamp") as string;
  const token = formData.get("token") as string;
  const signature = formData.get("signature") as string;

  if (!timestamp || !token || !signature) {
    logger.warn("Mailgun webhook missing signature fields", {
      hasTimestamp: !!timestamp,
      hasToken: !!token,
      hasSignature: !!signature,
    });
    return new Response("Missing Signature", { status: 406 });
  }

  if (!verifySignature(timestamp, token, signature, signingKey)) {
    logger.warn("Mailgun webhook signature verification failed");
    return new Response("Invalid Signature", { status: 406 });
  }

  // 3b. Reject stale requests and replays. The signature covers only
  // (timestamp, token), not the body, so a captured valid triple is otherwise
  // replayable forever with arbitrary content.
  if (!isTimestampFresh(timestamp)) {
    logger.warn("Mailgun webhook timestamp outside freshness window", { timestamp });
    return new Response("Stale Timestamp", { status: 406 });
  }

  if (await wasWebhookTokenSeen(token)) {
    // Token already handled to completion — a replay of an already-acknowledged
    // request. Ack without reprocessing (idempotent). A retry whose original
    // never completed won't hit this (the token is marked only on completion).
    logger.warn("Mailgun webhook token replay detected; ignoring");
    return new Response("OK", { status: 200 });
  }

  // 4. Validate required fields
  const fromField = formData.get("from") as string;
  const recipient = formData.get("recipient") as string;

  if (!fromField || !recipient) {
    logger.warn("Mailgun webhook missing required fields", {
      hasFrom: !!fromField,
      hasRecipient: !!recipient,
    });
    return new Response("Missing Required Fields", { status: 406 });
  }

  // 5. Parse Mailgun format into normalized format
  const email = parseMailgunEmail(formData);

  logger.debug("Processing inbound email from Mailgun", {
    to: email.to,
    from: email.from.address,
    subject: email.subject,
    messageId: email.messageId,
    hasHtml: !!email.html,
    hasText: !!email.text,
  });

  // 6. Process the email
  try {
    const result = await processInboundEmail(email);

    // Processing reached a durable decision (accepted or deliberately rejected),
    // so mark the token seen to reject future replays. Deliberately NOT done in
    // the catch below: an unexpected throw means the event wasn't durably
    // handled, so a Mailgun retry (same token) should be allowed to reprocess.
    await markWebhookTokenSeen(token);

    if (result.success) {
      logger.info("Mailgun email webhook processed successfully", {
        feedId: result.feedId,
        entryId: result.entryId,
        from: email.from.address,
      });
    } else {
      // Not an error - just rejected (invalid token, blocked sender, etc.)
      logger.debug("Mailgun email webhook rejected", {
        error: result.error,
        from: email.from.address,
        to: email.to,
      });
    }
  } catch (error) {
    // Unexpected throw (e.g. transient DB failure): the event was NOT durably
    // handled and the token was NOT marked seen, so return 500 to make Mailgun
    // retry — the retry passes the (unmarked) nonce check and reprocesses.
    // Reprocessing is idempotent (uq_entries_feed_guid + Message-ID dedup), and
    // Mailgun's retry schedule is bounded (~8 attempts over ~8h), so a
    // persistent failure can't retry forever. Returning 200 here instead would
    // silently drop the email.
    logger.error("Mailgun email webhook processing failed; returning 500 for retry", {
      error: error instanceof Error ? error.message : String(error),
      from: email.from.address,
      to: email.to,
      messageId: email.messageId,
    });
    return new Response("Processing Failed", { status: 500 });
  }

  // Return 200 to acknowledge receipt
  return new Response("OK", { status: 200 });
}

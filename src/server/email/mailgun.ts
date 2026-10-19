/**
 * Mailgun inbound-email webhook verification and parsing: HMAC signature,
 * timestamp freshness, Redis nonce replay protection, and the conversion of
 * Mailgun's form payload to an {@link InboundEmail}.
 */

import { createHmac, timingSafeEqual } from "crypto";
import type { InboundEmail } from "@/server/email/process-inbound";
import { getRedisClient } from "@/server/redis";
import { logger } from "@/lib/logger";
import { parseFromAddress } from "@/server/email/parse-utils";

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
export function isTimestampFresh(timestamp: string): boolean {
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
export async function wasWebhookTokenSeen(token: string): Promise<boolean> {
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
export async function markWebhookTokenSeen(token: string): Promise<void> {
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
export function verifySignature(
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
export function parseMailgunEmail(formData: FormData): InboundEmail {
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

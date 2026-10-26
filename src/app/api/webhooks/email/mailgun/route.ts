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

import { db } from "@/server/db";
import { processInboundEmail } from "@/server/email/process-inbound";
import {
  isTimestampFresh,
  markWebhookTokenSeen,
  parseMailgunEmail,
  verifySignature,
  wasWebhookTokenSeen,
} from "@/server/email/mailgun";
import { ingestConfig } from "@/server/config/env";
import { logger } from "@/lib/logger";

/**
 * Route segment config for Next.js
 */
export const dynamic = "force-dynamic";

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
  // 1. Check newsletters are configured
  const signingKey = ingestConfig.mailgunWebhookSigningKey;

  if (!signingKey || !ingestConfig.enabledDomain) {
    logger.error(
      "Mailgun webhook received but INGEST_EMAIL_DOMAIN or MAILGUN_WEBHOOK_SIGNING_KEY is not configured"
    );
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
    const result = await processInboundEmail(db, email);

    // Processing reached a durable decision (accepted or deliberately rejected),
    // so mark the token seen to reject future replays. Deliberately NOT done in
    // the catch below: an unexpected throw means the event wasn't durably
    // handled, so a Mailgun retry (same token) should be allowed to reprocess.
    await markWebhookTokenSeen(token);

    if (result.success) {
      logger.info("Mailgun email webhook processed successfully", {
        subscriptionId: result.subscriptionId,
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
    // Reprocessing is idempotent (uq_entries_owner_subscription_guid + Message-ID dedup), and
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

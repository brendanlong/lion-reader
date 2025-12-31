/**
 * Cloudflare Email Webhook Endpoint
 *
 * Receives inbound emails from Cloudflare Email Workers and processes them
 * as newsletter entries. This endpoint:
 * - Verifies the webhook secret
 * - Parses the Cloudflare email format into a normalized format
 * - Processes the email to create feed entries
 *
 * Always returns 200 OK to prevent Cloudflare from retrying.
 */

import { processInboundEmail, type InboundEmail } from "@/server/email";
import { ingestConfig } from "@/server/config/env";
import { logger } from "@/lib/logger";

/**
 * Route segment config for Next.js
 */
export const dynamic = "force-dynamic";

/**
 * Cloudflare Email Worker payload format.
 * Based on the Cloudflare Email Workers documentation.
 */
interface CloudflareEmailPayload {
  /** Sender in format "Name <email@example.com>" or just "email@example.com" */
  from: string;
  /** Recipient email address */
  to: string;
  /** Email subject */
  subject: string;
  /** Email headers as key-value pairs */
  headers: Record<string, string>;
  /** Plain text content (optional) */
  text?: string;
  /** HTML content (optional) */
  html?: string;
  /** Raw email content (optional, not used here) */
  raw?: string;
  /** Message-ID header (may be in headers instead) */
  messageId?: string;
  /** Spam score from Cloudflare (optional) */
  spamScore?: number;
  /** Whether Cloudflare flagged as spam (optional) */
  isSpam?: boolean;
}

/**
 * Parses a "From" address string into email and name components.
 * Handles formats:
 * - "Name <email@example.com>"
 * - "<email@example.com>"
 * - "email@example.com"
 *
 * @param from - The from string to parse
 * @returns Object with address and optional name
 */
function parseFromAddress(from: string): { address: string; name?: string } {
  // Try to match "Name <email>" format
  const matchWithName = from.match(/^(.+?)\s*<([^>]+)>$/);
  if (matchWithName) {
    const name = matchWithName[1].trim();
    const address = matchWithName[2].trim();
    return {
      address,
      name: name || undefined,
    };
  }

  // Try to match "<email>" format
  const matchAngleBrackets = from.match(/^<([^>]+)>$/);
  if (matchAngleBrackets) {
    return {
      address: matchAngleBrackets[1].trim(),
    };
  }

  // Assume it's just an email address
  return {
    address: from.trim(),
  };
}

/**
 * Extracts the Message-ID from email payload.
 * Checks both the messageId field and headers.
 *
 * @param payload - The Cloudflare email payload
 * @returns The Message-ID or a generated fallback
 */
function extractMessageId(payload: CloudflareEmailPayload): string {
  // Check direct field first
  if (payload.messageId) {
    return payload.messageId;
  }

  // Check headers (case-insensitive lookup)
  const headers = payload.headers ?? {};
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === "message-id" && value) {
      // Strip angle brackets if present
      return value.replace(/^<|>$/g, "");
    }
  }

  // Generate a fallback Message-ID using timestamp and from address
  const timestamp = Date.now();
  const fromAddress = parseFromAddress(payload.from).address;
  return `generated-${timestamp}-${fromAddress}`;
}

/**
 * Gets a header value case-insensitively.
 *
 * @param headers - Headers object
 * @param name - Header name to find
 * @returns Header value or undefined
 */
function getHeader(headers: Record<string, string> | undefined, name: string): string | undefined {
  if (!headers) return undefined;

  const lowerName = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lowerName) {
      return value;
    }
  }
  return undefined;
}

/**
 * Converts a Cloudflare email payload to our normalized InboundEmail format.
 *
 * @param payload - The Cloudflare email payload
 * @returns Normalized InboundEmail
 */
function parseCloudflareEmail(payload: CloudflareEmailPayload): InboundEmail {
  const from = parseFromAddress(payload.from);
  const messageId = extractMessageId(payload);

  return {
    to: payload.to,
    from,
    subject: payload.subject ?? "",
    messageId,
    html: payload.html,
    text: payload.text,
    headers: {
      listUnsubscribe: getHeader(payload.headers, "List-Unsubscribe"),
      listUnsubscribePost: getHeader(payload.headers, "List-Unsubscribe-Post"),
    },
    spamScore: payload.spamScore,
    isSpam: payload.isSpam,
  };
}

/**
 * POST /api/webhooks/email/cloudflare
 *
 * Handles incoming email webhooks from Cloudflare Email Workers.
 * Verifies the webhook secret and processes the email.
 *
 * Always returns 200 OK to prevent retries - we handle errors internally.
 */
export async function POST(request: Request): Promise<Response> {
  // 1. Verify webhook secret
  const secret = request.headers.get("X-Webhook-Secret");
  const expectedSecret = ingestConfig.webhookSecret;

  if (!expectedSecret) {
    logger.error("Email webhook received but EMAIL_WEBHOOK_SECRET is not configured");
    // Return 200 to prevent retries, but log the error
    return new Response("OK", { status: 200 });
  }

  if (secret !== expectedSecret) {
    logger.warn("Email webhook received with invalid secret", {
      hasSecret: !!secret,
    });
    // Return 401 for auth errors since Cloudflare should fix the secret
    return new Response("Unauthorized", { status: 401 });
  }

  // 2. Parse the request body
  let payload: CloudflareEmailPayload;
  try {
    payload = (await request.json()) as CloudflareEmailPayload;
  } catch (error) {
    logger.error("Failed to parse email webhook payload", {
      error: error instanceof Error ? error.message : String(error),
    });
    // Return 200 to prevent retries with malformed JSON
    return new Response("OK", { status: 200 });
  }

  // Basic validation
  if (!payload.from || !payload.to) {
    logger.warn("Email webhook missing required fields", {
      hasFrom: !!payload.from,
      hasTo: !!payload.to,
    });
    return new Response("OK", { status: 200 });
  }

  // 3. Parse Cloudflare format into normalized format
  const email = parseCloudflareEmail(payload);

  logger.debug("Processing inbound email", {
    to: email.to,
    from: email.from.address,
    subject: email.subject,
    messageId: email.messageId,
    hasHtml: !!email.html,
    hasText: !!email.text,
    isSpam: email.isSpam,
  });

  // 4. Process the email
  try {
    const result = await processInboundEmail(email);

    if (result.success) {
      logger.info("Email webhook processed successfully", {
        feedId: result.feedId,
        entryId: result.entryId,
        from: email.from.address,
      });
    } else {
      // Not an error - just rejected (invalid token, blocked sender, etc.)
      logger.debug("Email webhook rejected", {
        error: result.error,
        from: email.from.address,
        to: email.to,
      });
    }
  } catch (error) {
    // Log unexpected errors but still return 200 to prevent retries
    logger.error("Email webhook processing failed", {
      error: error instanceof Error ? error.message : String(error),
      from: email.from.address,
      to: email.to,
      messageId: email.messageId,
    });
  }

  // Always return 200 to prevent Cloudflare from retrying
  return new Response("OK", { status: 200 });
}

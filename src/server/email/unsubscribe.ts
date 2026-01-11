/**
 * Email Unsubscribe Module
 *
 * Handles sending unsubscribe requests to email newsletter senders.
 * Supports both mailto: and RFC 8058 one-click HTTPS POST methods.
 */

import { eq, desc, and, isNotNull, or } from "drizzle-orm";
import { db } from "../db";
import { entries } from "../db/schema";
import { logger } from "@/lib/logger";

// ============================================================================
// Types
// ============================================================================

/**
 * Result of an unsubscribe attempt.
 */
export interface UnsubscribeResult {
  /** Whether an unsubscribe request was sent */
  sent: boolean;
  /** The method used for unsubscribe (if sent) */
  method?: "mailto" | "https";
  /** The mailto URL used (if mailto method) */
  mailtoUrl?: string;
  /** Error message if the attempt failed */
  error?: string;
}

/**
 * Parsed mailto URL components.
 */
interface ParsedMailto {
  /** The recipient email address */
  to: string;
  /** The email subject (optional) */
  subject?: string;
  /** The email body (optional) */
  body?: string;
}

// ============================================================================
// Constants
// ============================================================================

/**
 * Timeout for HTTPS unsubscribe requests (10 seconds).
 */
const HTTPS_TIMEOUT_MS = 10000;

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Parses a mailto: URL into its components.
 *
 * Format: mailto:email@example.com?subject=Unsubscribe&body=...
 *
 * @param mailtoUrl - The mailto URL to parse
 * @returns Parsed components or null if invalid
 */
function parseMailtoUrl(mailtoUrl: string): ParsedMailto | null {
  try {
    // mailto: URLs use a non-standard format, so we need to handle them carefully
    if (!mailtoUrl.toLowerCase().startsWith("mailto:")) {
      return null;
    }

    // Extract the part after "mailto:"
    const urlPart = mailtoUrl.slice(7);

    // Split by '?' to separate email from query params
    const questionIndex = urlPart.indexOf("?");

    let toAddress: string;
    let queryString = "";

    if (questionIndex === -1) {
      toAddress = urlPart;
    } else {
      toAddress = urlPart.slice(0, questionIndex);
      queryString = urlPart.slice(questionIndex + 1);
    }

    // Decode the email address
    toAddress = decodeURIComponent(toAddress);

    if (!toAddress || !toAddress.includes("@")) {
      return null;
    }

    const result: ParsedMailto = { to: toAddress };

    // Parse query parameters
    if (queryString) {
      const params = new URLSearchParams(queryString);
      const subject = params.get("subject");
      const body = params.get("body");

      if (subject) {
        result.subject = subject;
      }
      if (body) {
        result.body = body;
      }
    }

    return result;
  } catch (error) {
    logger.warn("Failed to parse mailto URL", {
      mailtoUrl,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

// ============================================================================
// Unsubscribe Functions
// ============================================================================

/**
 * Sends an unsubscribe email (placeholder implementation).
 *
 * TODO: Implement actual email sending when outbound email is configured.
 * For now, this logs the email that would be sent.
 *
 * @param mailtoUrl - The mailto: URL from the List-Unsubscribe header
 * @returns Promise that resolves when "sent" (logged)
 */
async function sendUnsubscribeEmail(mailtoUrl: string): Promise<void> {
  const parsed = parseMailtoUrl(mailtoUrl);

  if (!parsed) {
    logger.error("Failed to parse mailto URL for unsubscribe", { mailtoUrl });
    throw new Error("Invalid mailto URL");
  }

  // TODO: Send actual email when outbound email provider is configured
  // For now, log what we would send
  logger.info("Would send unsubscribe email (outbound email not configured)", {
    to: parsed.to,
    subject: parsed.subject || "Unsubscribe",
    body: parsed.body || "Please unsubscribe this address from your mailing list.",
  });

  // Example implementation when email provider is available:
  // await emailProvider.send({
  //   to: parsed.to,
  //   subject: parsed.subject || "Unsubscribe",
  //   text: parsed.body || "Please unsubscribe this address from your mailing list.",
  // });
}

/**
 * Sends an RFC 8058 one-click unsubscribe POST request.
 *
 * Per RFC 8058, sends a POST request with:
 * - Content-Type: application/x-www-form-urlencoded
 * - Body: List-Unsubscribe=One-Click
 *
 * @param url - The HTTPS URL from the List-Unsubscribe header
 * @throws Error if the request fails
 */
async function sendUnsubscribePost(url: string): Promise<void> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), HTTPS_TIMEOUT_MS);

  try {
    logger.info("Sending RFC 8058 one-click unsubscribe POST", { url });

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "List-Unsubscribe=One-Click",
      signal: controller.signal,
    });

    if (!response.ok) {
      logger.warn("One-click unsubscribe POST returned non-OK status", {
        url,
        status: response.status,
        statusText: response.statusText,
      });
      // We don't throw here - the request was sent, even if the server didn't accept it
      // The sender may have already processed the unsubscribe or have different behavior
    } else {
      logger.info("One-click unsubscribe POST successful", { url, status: response.status });
    }
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      logger.warn("One-click unsubscribe POST timed out", { url });
      throw new Error("Unsubscribe request timed out");
    }

    logger.error("One-click unsubscribe POST failed", {
      url,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Attempts to unsubscribe from an email feed.
 *
 * This function:
 * 1. Finds the most recent entry with List-Unsubscribe info
 * 2. Tries mailto: first (simple and reliable)
 * 3. Falls back to HTTPS POST only if one-click is supported (RFC 8058)
 *
 * @param feedId - The ID of the email feed to unsubscribe from
 * @returns Result indicating whether unsubscribe was sent and which method was used
 */
export async function attemptUnsubscribe(feedId: string): Promise<UnsubscribeResult> {
  // Find the most recent entry with unsubscribe info
  const [entry] = await db
    .select({
      listUnsubscribeMailto: entries.listUnsubscribeMailto,
      listUnsubscribeHttps: entries.listUnsubscribeHttps,
      listUnsubscribePost: entries.listUnsubscribePost,
    })
    .from(entries)
    .where(
      and(
        eq(entries.feedId, feedId),
        or(isNotNull(entries.listUnsubscribeMailto), isNotNull(entries.listUnsubscribeHttps))
      )
    )
    .orderBy(desc(entries.id))
    .limit(1);

  if (!entry) {
    logger.info("No List-Unsubscribe info available for feed", { feedId });
    return { sent: false };
  }

  // Try mailto: first (simple and reliable)
  if (entry.listUnsubscribeMailto) {
    try {
      await sendUnsubscribeEmail(entry.listUnsubscribeMailto);
      logger.info("Unsubscribe email sent (or logged)", {
        feedId,
        mailtoUrl: entry.listUnsubscribeMailto,
      });
      return {
        sent: true,
        method: "mailto",
        mailtoUrl: entry.listUnsubscribeMailto,
      };
    } catch (error) {
      logger.warn("Failed to send unsubscribe email, will try HTTPS", {
        feedId,
        error: error instanceof Error ? error.message : String(error),
      });
      // Fall through to try HTTPS
    }
  }

  // Try HTTPS only if one-click POST is supported (RFC 8058)
  if (entry.listUnsubscribeHttps && entry.listUnsubscribePost) {
    try {
      await sendUnsubscribePost(entry.listUnsubscribeHttps);
      logger.info("One-click unsubscribe POST sent", {
        feedId,
        url: entry.listUnsubscribeHttps,
      });
      return {
        sent: true,
        method: "https",
      };
    } catch (error) {
      logger.warn("One-click unsubscribe POST failed", {
        feedId,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        sent: false,
        error: error instanceof Error ? error.message : "Unsubscribe request failed",
      };
    }
  }

  // HTTPS URL exists but one-click POST is not supported
  // We don't send requests to non-one-click URLs as they may require user interaction
  if (entry.listUnsubscribeHttps && !entry.listUnsubscribePost) {
    logger.info("HTTPS unsubscribe URL exists but one-click not supported", {
      feedId,
      url: entry.listUnsubscribeHttps,
    });
  }

  logger.info("No usable unsubscribe method available", { feedId });
  return { sent: false };
}

/**
 * Gets the most recent List-Unsubscribe mailto URL for a feed.
 * Used to store the URL in blocked_senders for potential retry.
 *
 * @param feedId - The feed ID
 * @returns The mailto URL or null if not found
 */
export async function getLatestUnsubscribeMailto(feedId: string): Promise<string | null> {
  const [entry] = await db
    .select({
      listUnsubscribeMailto: entries.listUnsubscribeMailto,
    })
    .from(entries)
    .where(and(eq(entries.feedId, feedId), isNotNull(entries.listUnsubscribeMailto)))
    .orderBy(desc(entries.id))
    .limit(1);

  return entry?.listUnsubscribeMailto ?? null;
}

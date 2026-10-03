/**
 * Email Unsubscribe Module
 *
 * Sends RFC 8058 one-click unsubscribe requests to email newsletter senders.
 * mailto: List-Unsubscribe is not attempted: we have no outbound email, and
 * reporting it as sent would hide that the sender was never unsubscribed.
 */

import { eq, desc, and, isNotNull } from "drizzle-orm";
import { db } from "../db";
import { entries } from "../db/schema";
import { fetchWithSsrfProtection } from "../http/ssrf";
import { USER_AGENT } from "../http/user-agent";
import { logger } from "@/lib/logger";

export interface UnsubscribeResult {
  /** Whether an unsubscribe request was sent */
  sent: boolean;
  /** The method used for unsubscribe (if sent) */
  method?: "https";
  /** Error message if the attempt failed */
  error?: string;
}

const HTTPS_TIMEOUT_MS = 10000;

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
  try {
    logger.info("Sending RFC 8058 one-click unsubscribe POST", { url });

    // The URL comes verbatim from the attacker-controllable List-Unsubscribe
    // email header, so this must go through the SSRF-protected fetch.
    const response = await fetchWithSsrfProtection(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": USER_AGENT,
      },
      body: "List-Unsubscribe=One-Click",
      signal: AbortSignal.timeout(HTTPS_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(`Unsubscribe request returned HTTP ${response.status}`);
    }
    logger.info("One-click unsubscribe POST successful", { url, status: response.status });
  } catch (error) {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      logger.warn("One-click unsubscribe POST timed out", { url });
      throw new Error("Unsubscribe request timed out");
    }

    logger.warn("One-click unsubscribe POST failed", {
      url,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/**
 * Attempts to unsubscribe from an email feed using the most recent entry that
 * advertises RFC 8058 one-click unsubscribe. Plain HTTPS unsubscribe URLs are
 * not requested, since they may require user interaction.
 */
export async function attemptUnsubscribe(feedId: string): Promise<UnsubscribeResult> {
  const [entry] = await db
    .select({ listUnsubscribeHttps: entries.listUnsubscribeHttps })
    .from(entries)
    .where(
      and(
        eq(entries.feedId, feedId),
        isNotNull(entries.listUnsubscribeHttps),
        eq(entries.listUnsubscribePost, true)
      )
    )
    .orderBy(desc(entries.id))
    .limit(1);

  if (!entry?.listUnsubscribeHttps) {
    logger.info("No one-click unsubscribe available for feed", { feedId });
    return { sent: false };
  }

  try {
    await sendUnsubscribePost(entry.listUnsubscribeHttps);
    logger.info("One-click unsubscribe POST sent", {
      feedId,
      url: entry.listUnsubscribeHttps,
    });
    return { sent: true, method: "https" };
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

/**
 * Gets the most recent List-Unsubscribe mailto URL for a feed, which is
 * recorded on the blocked_senders row.
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

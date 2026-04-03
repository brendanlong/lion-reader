/**
 * Auto-Subscribe New Users
 *
 * Subscribes new users to the Lion Reader announcements feed.
 * Runs asynchronously in the background so failures don't block signup.
 */

import * as Sentry from "@sentry/nextjs";

import { db } from "@/server/db";
import { subscribeByUrl } from "@/server/services/subscriptions";
import { logger } from "@/lib/logger";

export const ANNOUNCEMENTS_FEED_URL = "https://announcements.lionreader.com/feed.xml";

/**
 * Auto-subscribe a new user to the announcements feed.
 *
 * This runs in the background (fire-and-forget). Errors are logged
 * and reported to Sentry but never propagated to the caller.
 */
export function autoSubscribeNewUser(userId: string): void {
  subscribeByUrl(db, { userId, url: ANNOUNCEMENTS_FEED_URL }).catch((error: unknown) => {
    // "already subscribed" is expected if the user somehow already has it
    if (
      error instanceof Error &&
      "code" in error &&
      (error as { code: string }).code === "CONFLICT"
    ) {
      return;
    }

    logger.error("Failed to auto-subscribe user to announcements feed", {
      userId,
      error,
    });
    Sentry.captureException(error, {
      extra: { userId, context: "auto-subscribe announcements" },
    });
  });
}

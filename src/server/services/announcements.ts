/**
 * Announcements Feed Auto-Subscribe
 *
 * Subscribes new users to the Lion Reader announcements feed.
 * Runs async in the background — errors are logged/reported but never block signup.
 */

import * as Sentry from "@sentry/nextjs";
import { db } from "@/server/db";
import { createSubscription } from "@/server/services/subscriptions";
import { logger } from "@/lib/logger";

export const ANNOUNCEMENTS_FEED_URL = "https://announcements.lionreader.com/feed.xml";

/**
 * Subscribes a user to the Lion Reader announcements feed.
 * Fire-and-forget: errors are logged and sent to Sentry but never thrown.
 */
export async function subscribeToAnnouncementsFeed(userId: string): Promise<void> {
  try {
    await createSubscription(db, userId, { url: ANNOUNCEMENTS_FEED_URL });
    logger.info("Auto-subscribed user to announcements feed", { userId });
  } catch (error) {
    logger.error("Failed to auto-subscribe user to announcements feed", { userId, error });
    Sentry.captureException(error, {
      extra: { userId, context: "announcements-auto-subscribe" },
    });
  }
}

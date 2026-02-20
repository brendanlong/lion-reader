/**
 * Google Reader API: Quick Add Subscription
 *
 * POST /api/greader.php/reader/api/0/subscription/quickadd
 *
 * Subscribes to a feed by URL.
 *
 * Request body (form-encoded):
 *   quickadd={feedUrl}
 */

import { requireAuth } from "@/server/google-reader/auth";
import { parseFormData, jsonResponse, errorResponse } from "@/server/google-reader/parse";
import { uuidToInt64 } from "@/server/google-reader/id";
import * as subscriptionsService from "@/server/services/subscriptions";
import { db } from "@/server/db";
import { eq, isNull, and } from "drizzle-orm";
import { feeds, subscriptions } from "@/server/db/schema";
import { generateUuidv7 } from "@/lib/uuidv7";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const session = await requireAuth(request);

  const params = await parseFormData(request);
  const feedUrl = params.get("quickadd");

  if (!feedUrl) {
    return errorResponse("Missing required parameter: quickadd", 400);
  }

  // Validate URL
  try {
    new URL(feedUrl);
  } catch {
    return errorResponse("Invalid URL", 400);
  }

  try {
    // Check if the feed already exists
    const existingFeed = await db.select().from(feeds).where(eq(feeds.url, feedUrl)).limit(1);

    if (existingFeed.length > 0) {
      // Check if user is already subscribed
      const existingSub = await db
        .select()
        .from(subscriptions)
        .where(
          and(
            eq(subscriptions.feedId, existingFeed[0].id),
            eq(subscriptions.userId, session.user.id),
            isNull(subscriptions.unsubscribedAt)
          )
        )
        .limit(1);

      if (existingSub.length > 0) {
        // Already subscribed — return existing subscription
        const sub = await subscriptionsService.getSubscription(
          db,
          session.user.id,
          existingSub[0].id
        );
        return jsonResponse({
          query: feedUrl,
          numResults: 1,
          streamId: `feed/${uuidToInt64(sub.id).toString()}`,
          streamName: sub.title ?? feedUrl,
        });
      }
    }

    // Create the feed if it doesn't exist, then subscribe
    // Use a simplified approach: create the feed record and subscription
    let feedId: string;

    if (existingFeed.length > 0) {
      feedId = existingFeed[0].id;
    } else {
      feedId = generateUuidv7();
      await db.insert(feeds).values({
        id: feedId,
        type: "web",
        url: feedUrl,
        nextFetchAt: new Date(), // Fetch immediately
      });
    }

    // Create subscription
    const subscriptionId = generateUuidv7();
    const now = new Date();
    await db.insert(subscriptions).values({
      id: subscriptionId,
      userId: session.user.id,
      feedId,
      subscribedAt: now,
      createdAt: now,
      updatedAt: now,
    });

    return jsonResponse({
      query: feedUrl,
      numResults: 1,
      streamId: `feed/${uuidToInt64(subscriptionId).toString()}`,
      streamName: feedUrl,
    });
  } catch (err) {
    console.error("Failed to subscribe to feed:", err);
    const message = err instanceof Error ? err.message : "Unknown error";
    return errorResponse(`Failed to subscribe: ${message}`, 500);
  }
}

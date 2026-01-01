/**
 * Server-Sent Events (SSE) Endpoint
 *
 * Provides real-time updates for authenticated users.
 * Subscribes to Redis pub/sub and forwards relevant feed events.
 *
 * Events:
 * - new_entry: A new entry was added to a subscribed feed
 * - entry_updated: An existing entry's content was updated
 * - subscription_created: User subscribed to a new feed
 * - saved_article_created: User saved a new article via bookmarklet
 *
 * Heartbeat: Sent every 30 seconds as a comment (: heartbeat)
 */

import { db } from "@/server/db";
import { subscriptions } from "@/server/db/schema";
import { validateSession } from "@/server/auth";
import {
  createSubscriberClient,
  getFeedEventsChannel,
  getUserEventsChannel,
  parseFeedEvent,
  parseUserEvent,
  type FeedEvent,
  type UserEvent,
} from "@/server/redis/pubsub";
import { eq, and, isNull } from "drizzle-orm";
import {
  incrementSSEConnections,
  decrementSSEConnections,
  trackSSEEventSent,
} from "@/server/metrics/metrics";

// ============================================================================
// Constants
// ============================================================================

/**
 * Heartbeat interval in milliseconds (30 seconds)
 */
const HEARTBEAT_INTERVAL_MS = 30_000;

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Extracts session token from request headers.
 * Supports both cookie-based and Authorization header authentication.
 */
function getSessionToken(headers: Headers): string | null {
  // Check Authorization header first (for API clients)
  const authHeader = headers.get("authorization");
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice(7);
  }

  // Check cookie (for browser clients)
  const cookieHeader = headers.get("cookie");
  if (cookieHeader) {
    const cookies = Object.fromEntries(
      cookieHeader.split("; ").map((c) => {
        const [key, ...value] = c.split("=");
        return [key, value.join("=")];
      })
    );
    if (cookies.session) {
      return cookies.session;
    }
  }

  return null;
}

/**
 * Gets all active feed IDs for a user's subscriptions.
 */
async function getUserFeedIds(userId: string): Promise<Set<string>> {
  const userSubscriptions = await db
    .select({ feedId: subscriptions.feedId })
    .from(subscriptions)
    .where(and(eq(subscriptions.userId, userId), isNull(subscriptions.unsubscribedAt)));

  return new Set(userSubscriptions.map((s) => s.feedId));
}

/**
 * Formats an SSE event message for feed events.
 */
function formatSSEFeedEvent(event: FeedEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

/**
 * Formats an SSE event message for user events.
 */
function formatSSEUserEvent(event: UserEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

/**
 * Formats an SSE heartbeat comment.
 */
function formatSSEHeartbeat(): string {
  return ": heartbeat\n\n";
}

// ============================================================================
// Route Handler
// ============================================================================

/**
 * GET /api/v1/events
 *
 * SSE stream for real-time feed updates.
 * Requires authentication via session cookie or Bearer token.
 */
export async function GET(req: Request): Promise<Response> {
  // Authenticate the user
  const token = getSessionToken(req.headers);
  if (!token) {
    return new Response(
      JSON.stringify({
        error: {
          code: "UNAUTHORIZED",
          message: "Authentication required",
        },
      }),
      {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  const sessionData = await validateSession(token);
  if (!sessionData) {
    return new Response(
      JSON.stringify({
        error: {
          code: "UNAUTHORIZED",
          message: "Invalid or expired session",
        },
      }),
      {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  const userId = sessionData.user.id;

  // Get user's subscribed feed IDs
  const feedIds = await getUserFeedIds(userId);

  // Get the user-specific events channel
  const userEventsChannel = getUserEventsChannel(userId);

  // Create readable stream for SSE
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      let subscriber: ReturnType<typeof createSubscriberClient> | null = null;
      let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
      let isCleanedUp = false;

      // Track which feed channels we're subscribed to
      const subscribedFeedChannels = new Set<string>();

      /**
       * Cleanup function to close Redis subscription and clear heartbeat
       */
      function cleanup(): void {
        if (isCleanedUp) return;
        isCleanedUp = true;

        // Decrement active SSE connections counter
        decrementSSEConnections();

        if (heartbeatInterval) {
          clearInterval(heartbeatInterval);
          heartbeatInterval = null;
        }

        if (subscriber) {
          subscriber.unsubscribe().catch(() => {
            // Ignore unsubscribe errors during cleanup
          });
          subscriber.quit().catch(() => {
            // Ignore quit errors during cleanup
          });
          subscriber = null;
        }
      }

      /**
       * Sends data to the stream, handling any errors
       */
      function send(data: string): void {
        if (isCleanedUp) return;
        try {
          controller.enqueue(encoder.encode(data));
        } catch {
          // Stream may have been closed
          cleanup();
        }
      }

      /**
       * Subscribes to a feed's event channel
       */
      function subscribeToFeed(feedId: string): void {
        if (isCleanedUp || !subscriber) return;

        const channel = getFeedEventsChannel(feedId);
        if (subscribedFeedChannels.has(channel)) return;

        subscribedFeedChannels.add(channel);
        subscriber.subscribe(channel).catch((err) => {
          console.error(`Failed to subscribe to feed channel ${feedId}:`, err);
          subscribedFeedChannels.delete(channel);
        });
      }

      // Set up abort handler for client disconnection
      req.signal.addEventListener("abort", () => {
        cleanup();
        try {
          controller.close();
        } catch {
          // Controller may already be closed
        }
      });

      // Create Redis subscriber
      try {
        subscriber = createSubscriberClient();

        // Build list of channels to subscribe to:
        // - User-specific channel for subscription events
        // - Per-feed channels for each subscribed feed
        const feedChannels = Array.from(feedIds).map(getFeedEventsChannel);
        const allChannels = [userEventsChannel, ...feedChannels];

        // Track subscribed feed channels
        for (const channel of feedChannels) {
          subscribedFeedChannels.add(channel);
        }

        // Subscribe to all channels
        if (allChannels.length > 0) {
          subscriber.subscribe(...allChannels).catch((err) => {
            console.error("Failed to subscribe to channels:", err);
            cleanup();
            try {
              controller.error(err);
            } catch {
              // Controller may already be closed
            }
          });
        }

        // Handle incoming messages
        subscriber.on("message", (channel: string, message: string) => {
          // Handle user events (subscription_created, saved_article_created)
          if (channel === userEventsChannel) {
            const event = parseUserEvent(message);
            if (!event) return;

            if (event.type === "subscription_created") {
              // Subscribe to the new feed's channel
              subscribeToFeed(event.feedId);

              // Forward the event to the client
              send(formatSSEUserEvent(event));
              trackSSEEventSent(event.type);
            } else if (event.type === "saved_article_created") {
              // Forward the event to the client
              send(formatSSEUserEvent(event));
              trackSSEEventSent(event.type);
            }
            return;
          }

          // Handle feed events (new_entry, entry_updated)
          // Since we only subscribe to channels for feeds we care about,
          // we don't need to filter here - just forward the event
          if (subscribedFeedChannels.has(channel)) {
            const event = parseFeedEvent(message);
            if (!event) return;

            send(formatSSEFeedEvent(event));
            trackSSEEventSent(event.type);
          }
        });

        // Handle Redis errors
        subscriber.on("error", (err) => {
          console.error("Redis subscriber error:", err);
          // Don't cleanup on transient errors - ioredis handles reconnection
        });

        // Start heartbeat
        heartbeatInterval = setInterval(() => {
          send(formatSSEHeartbeat());
          trackSSEEventSent("heartbeat");
        }, HEARTBEAT_INTERVAL_MS);

        // Increment active SSE connections counter
        incrementSSEConnections();

        // Send initial heartbeat to confirm connection
        send(formatSSEHeartbeat());
        trackSSEEventSent("heartbeat");
      } catch (err) {
        console.error("Failed to set up SSE connection:", err);
        cleanup();
        try {
          controller.error(err);
        } catch {
          // Controller may already be closed
        }
      }
    },
  });

  // Return SSE response
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no", // Disable nginx buffering
    },
  });
}

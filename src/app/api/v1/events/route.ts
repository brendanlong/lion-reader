/**
 * Server-Sent Events (SSE) Endpoint
 *
 * Provides real-time updates for authenticated users.
 * Subscribes to Redis pub/sub and forwards relevant feed events.
 *
 * Events:
 * - new_entry: A new entry was added to a subscribed feed (or saved article)
 * - entry_updated: An existing entry's content was updated
 * - entry_state_changed: Entry read/starred state changed
 * - subscription_created: User subscribed to a new feed
 * - subscription_updated: Subscription properties changed (tags, custom title)
 * - subscription_deleted: User unsubscribed from a feed
 * - tag_created: User created a new tag
 * - tag_updated: User updated a tag
 * - tag_deleted: User deleted a tag
 * - import_progress: OPML import progress update
 * - import_completed: OPML import completed
 *
 * Heartbeat: Sent every 30 seconds as a comment (: heartbeat)
 */

import { db } from "@/server/db";
import { subscriptions, subscriptionTags } from "@/server/db/schema";
import { validateSession } from "@/server/auth/session";
import { getSavedFeedId } from "@/server/feed/saved-feed";
import {
  createPubSubSubscription,
  getFeedEventsChannel,
  getUserEventsChannel,
  parseFeedEvent,
  parseUserEvent,
  checkRedisHealth,
  type PubSubSubscription,
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
 * Per-user subscription context for a feed: the subscription ID and the
 * subscription's tag IDs. Tag IDs are included in new_entry events so the
 * client can update tag unread counts without cached subscription data (#892).
 */
interface FeedSubscriptionInfo {
  subscriptionId: string;
  tagIds: string[];
}

/**
 * Gets a mapping of feedId -> { subscriptionId, tagIds } for a user's active
 * subscriptions. This allows the SSE endpoint to transform feed events (which
 * use feedId) into subscription-centric events (which use subscriptionId and
 * the subscription's tags) for the client.
 */
async function getUserFeedSubscriptionMap(
  userId: string
): Promise<Map<string, FeedSubscriptionInfo>> {
  const rows = await db
    .select({
      feedId: subscriptions.feedId,
      subscriptionId: subscriptions.id,
      tagId: subscriptionTags.tagId,
    })
    .from(subscriptions)
    .leftJoin(subscriptionTags, eq(subscriptionTags.subscriptionId, subscriptions.id))
    .where(and(eq(subscriptions.userId, userId), isNull(subscriptions.unsubscribedAt)));

  const map = new Map<string, FeedSubscriptionInfo>();
  for (const row of rows) {
    let info = map.get(row.feedId);
    if (!info) {
      info = { subscriptionId: row.subscriptionId, tagIds: [] };
      map.set(row.feedId, info);
    }
    if (row.tagId) {
      info.tagIds.push(row.tagId);
    }
  }
  return map;
}

/**
 * Formats an SSE event message for user events.
 * Includes an `id` field with server timestamp for client sync cursor tracking.
 */
function formatSSEUserEvent(event: UserEvent): string {
  const cursor = new Date().toISOString();
  return `event: ${event.type}\nid: ${cursor}\ndata: ${JSON.stringify(event)}\n\n`;
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

  // Check Redis health before establishing SSE connection
  const redisHealthy = await checkRedisHealth();
  if (!redisHealthy) {
    return new Response(
      JSON.stringify({
        error: {
          code: "SERVICE_UNAVAILABLE",
          message: "Real-time updates temporarily unavailable. Use sync endpoint for updates.",
        },
      }),
      {
        status: 503,
        headers: {
          "Content-Type": "application/json",
          "Retry-After": "30",
          "X-Fallback-Sync": "true",
        },
      }
    );
  }

  // Get user's feed -> subscription mapping
  const feedToSubscriptionMap = await getUserFeedSubscriptionMap(userId);

  // Get the user's saved feed ID (if it exists)
  const savedFeedId = await getSavedFeedId(db, userId);

  // Get the user-specific events channel
  const userEventsChannel = getUserEventsChannel(userId);

  // Create readable stream for SSE
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      let subscription: PubSubSubscription | null = null;
      let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
      let isCleanedUp = false;

      // Track which feed channels we're subscribed to
      const subscribedFeedChannels = new Set<string>();

      // Local copy of feed -> subscription mapping (updated on subscription events)
      const feedSubscriptionMap = new Map(feedToSubscriptionMap);

      /**
       * Cleanup function to release Redis channel subscriptions and clear heartbeat
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

        if (subscription) {
          subscription.close();
          subscription = null;
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
       * Subscribes to a feed's event channel and tracks the subscription mapping
       */
      function subscribeToFeed(feedId: string, info: FeedSubscriptionInfo): void {
        if (isCleanedUp || !subscription) return;

        const channel = getFeedEventsChannel(feedId);
        if (subscribedFeedChannels.has(channel)) return;

        subscribedFeedChannels.add(channel);
        feedSubscriptionMap.set(feedId, info);
        subscription.subscribe(channel).catch((err) => {
          console.error(`Failed to subscribe to feed channel ${feedId}:`, err);
          subscribedFeedChannels.delete(channel);
          feedSubscriptionMap.delete(feedId);
        });
      }

      /**
       * Unsubscribes from a feed's event channel and removes the subscription mapping
       */
      function unsubscribeFromFeed(feedId: string): void {
        if (isCleanedUp || !subscription) return;

        const channel = getFeedEventsChannel(feedId);
        if (!subscribedFeedChannels.has(channel)) return;

        subscribedFeedChannels.delete(channel);
        feedSubscriptionMap.delete(feedId);
        subscription.unsubscribe(channel);
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

      /**
       * Handles messages from subscribed Redis channels (via the process-wide
       * shared subscriber connection).
       */
      function handleMessage(channel: string, message: string): void {
        // Handle user events (subscriptions, tags, imports, entry state)
        if (channel === userEventsChannel) {
          const event = parseUserEvent(message);
          if (!event) return;

          // Handle side effects for subscription/tag lifecycle events,
          // keeping the per-connection feed -> subscription/tags mapping current
          if (event.type === "subscription_created") {
            subscribeToFeed(event.feedId, {
              subscriptionId: event.subscriptionId,
              tagIds: event.subscription.tags.map((tag) => tag.id),
            });
          } else if (event.type === "subscription_deleted") {
            unsubscribeFromFeed(event.feedId);
          } else if (event.type === "subscription_updated") {
            for (const info of feedSubscriptionMap.values()) {
              if (info.subscriptionId === event.subscriptionId) {
                info.tagIds = event.tags.map((tag) => tag.id);
              }
            }
          } else if (event.type === "tag_deleted") {
            for (const info of feedSubscriptionMap.values()) {
              info.tagIds = info.tagIds.filter((tagId) => tagId !== event.tagId);
            }
          }

          // All user events are forwarded to the client
          send(formatSSEUserEvent(event));
          trackSSEEventSent(event.type);
          return;
        }

        // Handle feed events (new_entry, entry_updated)
        // Transform events to use subscriptionId instead of feedId for client
        if (subscribedFeedChannels.has(channel)) {
          const event = parseFeedEvent(message);
          if (!event) return;

          // Look up the subscription info for this feed
          // For saved feeds, subscriptionId will be null (no subscription exists)
          const subscriptionInfo = feedSubscriptionMap.get(event.feedId) ?? null;

          // Transform event to use subscriptionId instead of feedId
          // Include metadata for entry_updated events to enable direct cache updates
          const clientEvent: Record<string, unknown> = {
            type: event.type,
            subscriptionId: subscriptionInfo?.subscriptionId ?? null,
            entryId: event.entryId,
            timestamp: event.timestamp,
            updatedAt: event.updatedAt, // Database updated_at for cursor tracking
            feedType: event.feedType,
          };

          // Include the subscription's tag IDs so the client can update tag
          // unread counts without cached subscription data (#892)
          if (event.type === "new_entry" && subscriptionInfo) {
            clientEvent.tagIds = subscriptionInfo.tagIds;
          }

          // Include metadata for entry_updated events
          if (event.type === "entry_updated") {
            clientEvent.metadata = event.metadata;
          }

          const cursor = new Date().toISOString();
          send(
            `event: ${clientEvent.type}\nid: ${cursor}\ndata: ${JSON.stringify(clientEvent)}\n\n`
          );
          trackSSEEventSent(event.type);
        }
      }

      // Set up the subscription on the shared Redis subscriber
      try {
        subscription = createPubSubSubscription(handleMessage);

        // This should never happen since we checked Redis health above,
        // but handle it gracefully just in case
        if (!subscription) {
          controller.error(new Error("Redis subscriber unavailable"));
          return;
        }

        // Build list of channels to subscribe to:
        // - User-specific channel for subscription events
        // - Per-feed channels for each subscribed feed
        // - Saved feed channel (if user has a saved feed)
        const feedIds = Array.from(feedSubscriptionMap.keys());
        const feedChannels = feedIds.map(getFeedEventsChannel);
        const allChannels = [userEventsChannel, ...feedChannels];

        // Add saved feed channel if it exists
        if (savedFeedId) {
          const savedFeedChannel = getFeedEventsChannel(savedFeedId);
          allChannels.push(savedFeedChannel);
          subscribedFeedChannels.add(savedFeedChannel);
        }

        // Track subscribed feed channels
        for (const channel of feedChannels) {
          subscribedFeedChannels.add(channel);
        }

        // Subscribe to all channels
        subscription.subscribe(...allChannels).catch((err) => {
          console.error("Failed to subscribe to channels:", err);
          cleanup();
          try {
            controller.error(err);
          } catch {
            // Controller may already be closed
          }
        });

        // Start heartbeat
        heartbeatInterval = setInterval(() => {
          send(formatSSEHeartbeat());
          trackSSEEventSent("heartbeat");
        }, HEARTBEAT_INTERVAL_MS);

        // Increment active SSE connections counter
        incrementSSEConnections();

        // Send initial connected event with cursor for client sync tracking
        const initialCursor = new Date().toISOString();
        send(
          `event: connected\nid: ${initialCursor}\ndata: ${JSON.stringify({ cursor: initialCursor })}\n\n`
        );
        trackSSEEventSent("connected");

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

/**
 * HEAD /api/v1/events
 *
 * Lightweight SSE availability check: reports whether real-time updates are
 * available (Redis healthy) without the per-connection auth and subscription
 * queries that GET performs. The client calls this only after an EventSource
 * failure to decide between reconnecting (non-503) and falling back to
 * polling (503), so the happy path uses a single connection.
 */
export async function HEAD(): Promise<Response> {
  const redisHealthy = await checkRedisHealth();
  if (!redisHealthy) {
    return new Response(null, {
      status: 503,
      headers: {
        "Retry-After": "30",
        "X-Fallback-Sync": "true",
      },
    });
  }
  return new Response(null, { status: 200 });
}

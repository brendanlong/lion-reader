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
 * - mark_all_read: A mark-all-read happened; clients invalidate lists + counts
 * - subscription_created: User subscribed to a new feed
 * - subscription_updated: Subscription properties changed (tags, custom title)
 * - subscription_deleted: User unsubscribed from a feed
 * - tag_created: User created a new tag
 * - tag_updated: User updated a tag
 * - tag_deleted: User deleted a tag
 * - import_progress: OPML import progress update
 * - import_completed: OPML import completed
 * - announcement_changed: Global announcement banner changed (broadcast to all)
 *
 * Heartbeat: Sent every 30 seconds as a comment (: heartbeat). Each heartbeat
 * also re-checks the session or app token the stream was opened with, and
 * closes the stream once it's revoked or expired — otherwise a stream would
 * keep delivering the user's events after a sign-out elsewhere (#1701).
 */

import { db } from "@/server/db";
import { feeds, subscriptions } from "@/server/db/schema";
import { authenticateRouteRequest } from "@/server/auth/route-auth";
import { getSavedFeedId } from "@/server/feed/saved-feed";
import { getBulkEntryRelatedCounts, type BulkUnreadCounts } from "@/server/services/counts";
import {
  createPubSubSubscription,
  getFeedEventsChannel,
  getUserEventsChannel,
  getSiteStatusChannel,
  parseFeedEvent,
  parseUserEvent,
  parseSiteStatusEvent,
  checkRedisHealth,
  type PubSubSubscription,
  type UserEvent,
} from "@/server/redis/pubsub";
import { eq, and, isNull, ne } from "drizzle-orm";
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
 * Gets a mapping of feedId -> subscriptionId for a user's active subscriptions.
 * This lets the SSE endpoint transform feed events (which use feedId) into
 * subscription-centric events (which use subscriptionId) for the client.
 * Collections are left out: their feeds never publish.
 */
async function getUserFeedSubscriptionMap(userId: string): Promise<Map<string, string>> {
  const rows = await db
    .select({
      feedId: subscriptions.feedId,
      subscriptionId: subscriptions.id,
    })
    .from(subscriptions)
    .innerJoin(feeds, eq(feeds.id, subscriptions.feedId))
    .where(
      and(
        eq(subscriptions.userId, userId),
        isNull(subscriptions.unsubscribedAt),
        ne(feeds.type, "collection")
      )
    );

  const map = new Map<string, string>();
  for (const row of rows) {
    map.set(row.feedId, row.subscriptionId);
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
  // Browser sessions, or the first-party app's OAuth token for confirmed users
  // only (as on the tRPC procedures it can reach).
  const auth = await authenticateRouteRequest(req.headers);
  if (!auth || (auth.credential === "app-token" && !auth.confirmed)) {
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

  const userId: string = auth.userId;
  const isCredentialActive = auth.isCredentialActive;

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

  // The single global site-status channel (announcement banner broadcasts).
  const siteStatusChannel = getSiteStatusChannel();

  // Holds the active connection's cleanup so the stream's cancel() callback can
  // release Redis channels even when no abort event fires (some runtimes cancel
  // the stream without aborting req.signal).
  let cleanupRef: (() => void) | null = null;

  // Create readable stream for SSE
  const stream = new ReadableStream({
    start(controller) {
      // If the request was already aborted before start() ran, the abort event
      // fired before we could register a listener and will never fire again.
      // Bail out before subscribing/incrementing so we don't leak the
      // ref-counted Redis channels (or skew the connection gauge).
      if (req.signal.aborted) {
        try {
          controller.close();
        } catch {
          // Controller may already be closed
        }
        return;
      }

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

      // Expose cleanup to the stream's cancel() callback below.
      cleanupRef = cleanup;

      // Increment the active-connections gauge here, strictly paired with the
      // decrement in cleanup(): every early return past this point (including a
      // failed Redis setup) runs cleanup(), so the gauge can't drift. The
      // already-aborted bail-out above returns before this and never increments.
      incrementSSEConnections();

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
      function subscribeToFeed(feedId: string, subscriptionId: string): void {
        if (isCleanedUp || !subscription) return;

        const channel = getFeedEventsChannel(feedId);
        if (subscribedFeedChannels.has(channel)) return;

        subscribedFeedChannels.add(channel);
        feedSubscriptionMap.set(feedId, subscriptionId);
        subscription.subscribe(channel).catch((err) => {
          console.error(`Failed to subscribe to feed channel ${feedId}:`, err);
          subscribedFeedChannels.delete(channel);
          feedSubscriptionMap.delete(feedId);
        });
      }

      /**
       * Subscribes to a saved feed's event channel. Saved feeds have no
       * subscription row, so (unlike subscribeToFeed) no feedSubscriptionMap
       * entry is added — feed events for it resolve to a null subscriptionId,
       * matching how the saved feed is wired up at connect time.
       */
      function subscribeToSavedFeed(feedId: string): void {
        if (isCleanedUp || !subscription) return;

        const channel = getFeedEventsChannel(feedId);
        if (subscribedFeedChannels.has(channel)) return;

        subscribedFeedChannels.add(channel);
        subscription.subscribe(channel).catch((err) => {
          console.error(`Failed to subscribe to saved feed channel ${feedId}:`, err);
          subscribedFeedChannels.delete(channel);
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

      let credentialCheckInFlight = false;
      async function closeIfCredentialInactive(): Promise<void> {
        if (credentialCheckInFlight || isCleanedUp) return;
        credentialCheckInFlight = true;
        let active: boolean;
        try {
          active = await isCredentialActive();
        } catch (err) {
          // Fail closed: the client reconnects, re-authenticating from scratch.
          console.error("Failed to re-check SSE credential:", err);
          active = false;
        } finally {
          credentialCheckInFlight = false;
        }
        if (active) return;
        cleanup();
        try {
          controller.close();
        } catch {
          // Controller may already be closed
        }
      }

      /**
       * Serializes event delivery so clients receive events in Redis-delivery
       * order even though new_entry needs an async count query before sending.
       * Without this, a new_entry carrying an older counts snapshot could
       * arrive after a newer count-bearing event (e.g. entry_state_changed)
       * and briefly regress the badge, and two new_entry queries could
       * complete out of order.
       */
      let sendChain: Promise<void> = Promise.resolve();
      function enqueueSend(task: () => void | Promise<void>): void {
        sendChain = sendChain.then(task).catch((err) => {
          console.error("Failed to deliver SSE event:", err);
        });
      }

      /**
       * Handles messages from subscribed Redis channels (via the process-wide
       * shared subscriber connection).
       */
      function handleMessage(channel: string, message: string): void {
        // Handle global site-status events (announcement banner). Broadcast on a
        // single channel to every connection; forwarded to the client as-is.
        if (channel === siteStatusChannel) {
          const event = parseSiteStatusEvent(message);
          if (!event) return;
          enqueueSend(() => {
            const cursor = new Date().toISOString();
            send(`event: ${event.type}\nid: ${cursor}\ndata: ${JSON.stringify(event)}\n\n`);
            trackSSEEventSent(event.type);
          });
          return;
        }

        // Handle user events (subscriptions, tags, imports, entry state)
        if (channel === userEventsChannel) {
          const event = parseUserEvent(message);
          if (!event) return;

          // Keep the per-connection feed -> subscription mapping current so
          // feed events can be subscribed to / resolved. Per-user counts on
          // new_entry are computed from the DB, so no tag bookkeeping is needed.
          // (Done synchronously, outside the send chain, so channel membership
          // updates aren't delayed behind pending count queries.)
          if (event.type === "subscription_created" && event.feed.type !== "collection") {
            subscribeToFeed(event.feedId, event.subscriptionId);
          } else if (event.type === "subscription_deleted") {
            unsubscribeFromFeed(event.feedId);
          } else if (event.type === "saved_feed_created") {
            // The saved feed was created after this connection opened; subscribe
            // to its channel so the first saved article is delivered live.
            // Saved feeds have no subscription (subscriptionId stays null), so we
            // add the channel directly rather than via subscribeToFeed.
            subscribeToSavedFeed(event.feedId);
            // Server-internal signal — nothing for the client to handle.
            return;
          }

          // All user events are forwarded to the client
          enqueueSend(() => {
            send(formatSSEUserEvent(event));
            trackSSEEventSent(event.type);
          });
          return;
        }

        // Handle feed events (new_entry, entry_updated)
        // Transform events to use subscriptionId instead of feedId for client
        if (subscribedFeedChannels.has(channel)) {
          const event = parseFeedEvent(message);
          if (!event) return;

          // Look up the subscription for this feed.
          // For saved feeds, subscriptionId will be null (no subscription exists)
          const subscriptionId = feedSubscriptionMap.get(event.feedId) ?? null;

          if (event.type === "new_entry") {
            // Compute this user's absolute unread counts and send them with the
            // event so the client sets counts directly instead of applying a +1
            // delta. That makes new_entry idempotent: a reconnect catch-up sync
            // can re-deliver the same entry without double-counting. All write
            // paths publish new_entry only after the user_entries fanout, so
            // the entry is in visible_entries by the time this query runs.
            // This is a per-subscriber query on the feed fan-out path, the same
            // order as the per-subscriber user_entries inserts the worker
            // already does for each new entry.
            enqueueSend(async () => {
              let counts: BulkUnreadCounts | undefined;
              try {
                counts = await getBulkEntryRelatedCounts(db, userId, [{ subscriptionId }]);
              } catch (err) {
                // Leave counts off; the client skips the count update and it
                // self-heals on the next count-bearing event or refetch.
                console.error("Failed to compute new_entry counts:", err);
              }
              const cursor = new Date().toISOString();
              send(
                `event: new_entry\nid: ${cursor}\ndata: ${JSON.stringify({
                  type: "new_entry",
                  subscriptionId,
                  entryId: event.entryId,
                  timestamp: event.timestamp,
                  updatedAt: event.updatedAt,
                  feedType: event.feedType,
                  feedId: event.feedId,
                  ...(counts ? { counts } : {}),
                  // List-item data (absent from events published by a previous
                  // release) lets the client insert the entry into cached lists.
                  ...(event.entry ? { entry: event.entry } : {}),
                })}\n\n`
              );
              trackSSEEventSent("new_entry");
            });
            return;
          }

          // entry_updated: include metadata so the client can update caches directly
          enqueueSend(() => {
            const cursor = new Date().toISOString();
            send(
              `event: entry_updated\nid: ${cursor}\ndata: ${JSON.stringify({
                type: "entry_updated",
                subscriptionId,
                entryId: event.entryId,
                timestamp: event.timestamp,
                updatedAt: event.updatedAt, // Database updated_at for cursor tracking
                feedType: event.feedType,
                metadata: event.metadata,
              })}\n\n`
            );
            trackSSEEventSent(event.type);
          });
        }
      }

      // Set up the subscription on the shared Redis subscriber
      try {
        subscription = createPubSubSubscription(handleMessage);

        // This should never happen since we checked Redis health above,
        // but handle it gracefully just in case
        if (!subscription) {
          cleanup();
          controller.error(new Error("Redis subscriber unavailable"));
          return;
        }

        // Build list of channels to subscribe to:
        // - User-specific channel for subscription events
        // - Per-feed channels for each subscribed feed
        // - Saved feed channel (if user has a saved feed)
        const feedIds = Array.from(feedSubscriptionMap.keys());
        const feedChannels = feedIds.map(getFeedEventsChannel);
        const allChannels = [userEventsChannel, siteStatusChannel, ...feedChannels];

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
          void closeIfCredentialInactive();
        }, HEARTBEAT_INTERVAL_MS);

        // Send an initial heartbeat to confirm the connection. (The client
        // detects "connected" from the EventSource open event, and tracks sync
        // cursors from the events themselves, so no separate cursor event is
        // sent.)
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
    cancel() {
      // The consumer cancelled the stream (client disconnect). Release the
      // ref-counted Redis channels immediately instead of waiting for the next
      // heartbeat enqueue to fail (up to HEARTBEAT_INTERVAL_MS later).
      cleanupRef?.();
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

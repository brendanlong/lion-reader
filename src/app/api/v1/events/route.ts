/**
 * Server-Sent Events (SSE) Endpoint
 *
 * Provides real-time updates for authenticated users. This route owns auth,
 * the stream and the heartbeat; which channels a connection follows and how
 * their events reach the client is `@/server/realtime/sse-connection`.
 *
 * Events:
 * - new_entry: A new entry was added to a subscribed feed (or saved article)
 * - entry_updated: An existing entry's content was updated
 * - entry_state_changed: Entry read/starred state changed
 * - mark_all_read: A mark-all-read happened, with the absolute counts; clients refetch lists
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
 * hello: Sent first on every stream, with the server's build id, so a page
 * running an earlier deploy's JavaScript can reload.
 *
 * Heartbeat: Sent every 30 seconds as a comment (: heartbeat). Each heartbeat
 * also re-checks the session or app token the stream was opened with, and
 * closes the stream once it's revoked or expired — otherwise a stream would
 * keep delivering the user's events after a sign-out elsewhere (#1701).
 */

import { authenticateRouteRequest } from "@/server/auth/route-auth";
import { checkRedisHealth } from "@/server/redis/pubsub";
import {
  getUserFeedSubscriptionMap,
  startSseConnection,
  type SseConnection,
} from "@/server/realtime/sse-connection";
import type { helloEventSchema } from "@/lib/events/schemas";
import { BUILD_ID } from "@/lib/build-id";
import type { z } from "zod";
import {
  incrementSSEConnections,
  decrementSSEConnections,
  trackSSEEventSent,
} from "@/server/metrics/metrics";
import { logger } from "@/lib/logger";

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

function formatSSEHello(): string {
  return `event: hello\ndata: ${JSON.stringify({ buildId: BUILD_ID } satisfies z.input<typeof helloEventSchema>)}\n\n`;
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

  const feedSubscriptions = await getUserFeedSubscriptionMap(userId);

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
      let connection: SseConnection | null = null;
      let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
      let isCleanedUp = false;

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

        if (connection) {
          connection.close();
          connection = null;
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
          logger.error("Failed to re-check SSE credential", {
            userId,
            error: err instanceof Error ? err.message : String(err),
          });
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

      try {
        connection = startSseConnection({ userId, feedSubscriptions, send });

        // This should never happen since we checked Redis health above,
        // but handle it gracefully just in case
        if (!connection) {
          cleanup();
          controller.error(new Error("Redis subscriber unavailable"));
          return;
        }

        connection.subscribed.catch((err) => {
          logger.error("Failed to subscribe to SSE channels", {
            userId,
            error: err instanceof Error ? err.message : String(err),
          });
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

        // Flush the headers with a first event. (The client detects
        // "connected" from the EventSource open event, and tracks sync cursors
        // from the events themselves, so no separate cursor event is sent.)
        send(formatSSEHello());
        trackSSEEventSent("hello");
      } catch (err) {
        logger.error("Failed to set up SSE connection", {
          userId,
          error: err instanceof Error ? err.message : String(err),
        });
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

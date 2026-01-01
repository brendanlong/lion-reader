/**
 * useRealtimeUpdates Hook
 *
 * Manages a Server-Sent Events (SSE) connection to receive real-time feed updates.
 * Automatically invalidates React Query cache when new entries arrive or are updated.
 *
 * Features:
 * - Automatic connection when user is authenticated
 * - Exponential backoff reconnection on errors
 * - React Query cache invalidation for entries and subscriptions
 * - Connection status tracking
 */

"use client";

import { useEffect, useRef, useCallback, useState } from "react";
import { trpc } from "@/lib/trpc/client";

/**
 * Connection status for the SSE stream.
 */
export type ConnectionStatus = "connecting" | "connected" | "disconnected" | "error";

/**
 * Return type for the useRealtimeUpdates hook.
 */
export interface UseRealtimeUpdatesResult {
  /**
   * Current connection status.
   */
  status: ConnectionStatus;

  /**
   * Whether the connection is currently active.
   */
  isConnected: boolean;

  /**
   * Manually trigger a reconnection attempt.
   */
  reconnect: () => void;
}

/**
 * Maximum reconnection delay in milliseconds (30 seconds).
 */
const MAX_RECONNECT_DELAY_MS = 30_000;

/**
 * Initial reconnection delay in milliseconds (1 second).
 */
const INITIAL_RECONNECT_DELAY_MS = 1_000;

/**
 * Backoff multiplier for exponential backoff.
 */
const BACKOFF_MULTIPLIER = 2;

/**
 * Event data structure from the SSE endpoint for feed events.
 */
interface FeedEventData {
  type: "new_entry" | "entry_updated";
  feedId: string;
  entryId: string;
  timestamp: string;
}

/**
 * Event data structure from the SSE endpoint for subscription events.
 */
interface SubscriptionCreatedEventData {
  type: "subscription_created";
  userId: string;
  feedId: string;
  subscriptionId: string;
  timestamp: string;
}

/**
 * Event data structure from the SSE endpoint for saved article events.
 */
interface SavedArticleCreatedEventData {
  type: "saved_article_created";
  userId: string;
  entryId: string;
  timestamp: string;
}

type UserEventData = SubscriptionCreatedEventData | SavedArticleCreatedEventData;

type SSEEventData = FeedEventData | UserEventData;

/**
 * Parses SSE event data from a JSON string.
 */
function parseEventData(data: string): SSEEventData | null {
  try {
    const parsed: unknown = JSON.parse(data);

    if (typeof parsed !== "object" || parsed === null || !("type" in parsed)) {
      return null;
    }

    const event = parsed as Record<string, unknown>;

    // Handle feed events
    if (
      (event.type === "new_entry" || event.type === "entry_updated") &&
      typeof event.feedId === "string" &&
      typeof event.entryId === "string"
    ) {
      return {
        type: event.type,
        feedId: event.feedId,
        entryId: event.entryId,
        timestamp: typeof event.timestamp === "string" ? event.timestamp : new Date().toISOString(),
      };
    }

    // Handle user events - subscription_created
    if (
      event.type === "subscription_created" &&
      typeof event.userId === "string" &&
      typeof event.feedId === "string" &&
      typeof event.subscriptionId === "string"
    ) {
      return {
        type: event.type,
        userId: event.userId,
        feedId: event.feedId,
        subscriptionId: event.subscriptionId,
        timestamp: typeof event.timestamp === "string" ? event.timestamp : new Date().toISOString(),
      };
    }

    // Handle user events - saved_article_created
    if (
      event.type === "saved_article_created" &&
      typeof event.userId === "string" &&
      typeof event.entryId === "string"
    ) {
      return {
        type: event.type,
        userId: event.userId,
        entryId: event.entryId,
        timestamp: typeof event.timestamp === "string" ? event.timestamp : new Date().toISOString(),
      };
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Hook to manage real-time updates via Server-Sent Events.
 *
 * Connects to the /api/v1/events SSE endpoint and invalidates React Query
 * cache when feed events are received.
 *
 * @example
 * ```tsx
 * function AppLayout({ children }) {
 *   const { status, isConnected } = useRealtimeUpdates();
 *
 *   return (
 *     <div>
 *       {!isConnected && <ReconnectingBanner />}
 *       {children}
 *     </div>
 *   );
 * }
 * ```
 */
export function useRealtimeUpdates(): UseRealtimeUpdatesResult {
  const utils = trpc.useUtils();

  // Internal connection status (only set by EventSource callbacks)
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("disconnected");

  // Refs to persist across renders
  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectDelayRef = useRef(INITIAL_RECONNECT_DELAY_MS);
  const isManuallyClosedRef = useRef(false);
  const shouldConnectRef = useRef(false);
  const reconnectTriggerRef = useRef(0);

  // State to trigger reconnection
  const [reconnectTrigger, setReconnectTrigger] = useState(0);

  // Check if user is authenticated
  const userQuery = trpc.auth.me.useQuery(undefined, {
    retry: false,
    refetchOnWindowFocus: false,
  });

  const isAuthenticated = userQuery.isSuccess && userQuery.data?.user;

  /**
   * Cleans up the EventSource connection and any pending reconnection.
   */
  const cleanup = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
  }, []);

  /**
   * Handles incoming SSE events by invalidating the appropriate queries.
   */
  const handleEvent = useCallback(
    (event: MessageEvent) => {
      const data = parseEventData(event.data);
      if (!data) return;

      if (data.type === "new_entry") {
        // Invalidate the entries list to show new entries
        // This invalidates all entry queries (all feeds and specific feed)
        utils.entries.list.invalidate();

        // Invalidate subscriptions to update unread counts
        utils.subscriptions.list.invalidate();
      } else if (data.type === "entry_updated") {
        // Invalidate the specific entry if it's cached
        utils.entries.get.invalidate({ id: data.entryId });

        // Also invalidate the list in case the update affects display
        utils.entries.list.invalidate();
      } else if (data.type === "subscription_created") {
        // A new subscription was created (possibly from another tab/device)
        // Invalidate subscriptions to show the new feed in the sidebar
        utils.subscriptions.list.invalidate();

        // Also invalidate entries to fetch any entries that may have been
        // created before the SSE connection subscribed to the new feed's channel.
        // This handles the race condition where new_entry events arrive before
        // the subscription_created event.
        utils.entries.list.invalidate();
      } else if (data.type === "saved_article_created") {
        // A saved article was created (from bookmarklet in another window)
        // Invalidate the saved articles list to show the new article
        utils.entries.list.invalidate({ type: "saved" });

        // Also invalidate the count
        utils.entries.count.invalidate({ type: "saved" });
      }
    },
    [utils.entries, utils.subscriptions]
  );

  /**
   * Schedules a reconnection attempt with exponential backoff.
   */
  const scheduleReconnect = useCallback((connectFn: () => void) => {
    if (isManuallyClosedRef.current || !shouldConnectRef.current) return;

    // Clear any existing reconnection timeout
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
    }

    const delay = reconnectDelayRef.current;

    reconnectTimeoutRef.current = setTimeout(() => {
      // Increase delay for next attempt (exponential backoff)
      reconnectDelayRef.current = Math.min(
        reconnectDelayRef.current * BACKOFF_MULTIPLIER,
        MAX_RECONNECT_DELAY_MS
      );

      connectFn();
    }, delay);
  }, []);

  /**
   * Manual reconnection function exposed to consumers.
   */
  const reconnect = useCallback(() => {
    reconnectDelayRef.current = INITIAL_RECONNECT_DELAY_MS;
    isManuallyClosedRef.current = false;
    shouldConnectRef.current = true;

    // Clean up existing connection
    cleanup();

    // Trigger effect to create new connection
    reconnectTriggerRef.current += 1;
    setReconnectTrigger(reconnectTriggerRef.current);
  }, [cleanup]);

  // Effect to manage SSE connection based on authentication
  useEffect(() => {
    // Track whether we should be connected
    shouldConnectRef.current = !!isAuthenticated;

    if (!isAuthenticated) {
      isManuallyClosedRef.current = true;
      cleanup();
      // Don't set status here - derive it from isAuthenticated instead
      return;
    }

    // Already connected, nothing to do
    if (eventSourceRef.current?.readyState === EventSource.OPEN) {
      return;
    }

    // Clean up any existing connection
    cleanup();
    isManuallyClosedRef.current = false;

    const createConnection = () => {
      if (!shouldConnectRef.current || isManuallyClosedRef.current) {
        return;
      }

      // Set connecting status from within the async operation setup
      setConnectionStatus("connecting");

      try {
        const eventSource = new EventSource("/api/v1/events", {
          withCredentials: true,
        });

        eventSourceRef.current = eventSource;

        eventSource.onopen = () => {
          setConnectionStatus("connected");
          // Reset backoff delay on successful connection
          reconnectDelayRef.current = INITIAL_RECONNECT_DELAY_MS;
        };

        // Handle named events
        eventSource.addEventListener("new_entry", handleEvent);
        eventSource.addEventListener("entry_updated", handleEvent);
        eventSource.addEventListener("subscription_created", handleEvent);
        eventSource.addEventListener("saved_article_created", handleEvent);

        eventSource.onerror = () => {
          // EventSource will automatically try to reconnect, but we'll handle
          // it ourselves for better control over backoff
          if (eventSourceRef.current?.readyState === EventSource.CLOSED) {
            setConnectionStatus("error");
            cleanup();
            scheduleReconnect(createConnection);
          } else {
            // Connection is reconnecting automatically
            setConnectionStatus("connecting");
          }
        };
      } catch (error) {
        console.error("Failed to create EventSource:", error);
        setConnectionStatus("error");
        scheduleReconnect(createConnection);
      }
    };

    createConnection();

    return () => {
      isManuallyClosedRef.current = true;
      cleanup();
    };
  }, [isAuthenticated, reconnectTrigger, cleanup, handleEvent, scheduleReconnect]);

  // Handle visibility change - reconnect when tab becomes visible
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (
        document.visibilityState === "visible" &&
        isAuthenticated &&
        eventSourceRef.current?.readyState !== EventSource.OPEN
      ) {
        reconnect();
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [isAuthenticated, reconnect]);

  // Derive the effective status - if not authenticated, always disconnected
  const effectiveStatus: ConnectionStatus = isAuthenticated ? connectionStatus : "disconnected";

  return {
    status: effectiveStatus,
    isConnected: effectiveStatus === "connected",
    reconnect,
  };
}

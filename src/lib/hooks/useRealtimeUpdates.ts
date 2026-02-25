/**
 * useRealtimeUpdates Hook
 *
 * Manages real-time updates with SSE as primary and polling as fallback.
 *
 * Features:
 * - Primary: Server-Sent Events (SSE) via Redis pub/sub
 * - Fallback: Polling sync endpoint when SSE is unavailable (Redis down)
 * - Automatic catch-up sync after SSE reconnection
 * - Exponential backoff for reconnection attempts
 * - React Query cache invalidation
 * - Granular cursor tracking for each entity type (entries, subscriptions, tags, etc.)
 */

"use client";

import { useEffect, useRef, useCallback, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { trpc } from "@/lib/trpc/client";
import { handleSyncEvent } from "@/lib/cache/event-handlers";
import { syncEventSchema, type SyncEvent } from "@/lib/events/schemas";

/**
 * Sync cursors for each entity type.
 * Each cursor is an ISO8601 timestamp based on max(updated_at) for the entity type.
 */
export interface SyncCursors {
  entries: string | null;
  subscriptions: string | null;
  tags: string | null;
}

/**
 * Connection status for real-time updates.
 */
export type ConnectionStatus = "connecting" | "connected" | "disconnected" | "error" | "polling";

/**
 * Return type for the useRealtimeUpdates hook.
 */
export interface UseRealtimeUpdatesResult {
  /**
   * Current connection status.
   * - "connected": SSE connection is active
   * - "polling": Fallback polling mode (SSE unavailable)
   * - "connecting": Attempting to connect
   * - "disconnected": Not connected (not authenticated)
   * - "error": Connection failed
   */
  status: ConnectionStatus;

  /**
   * Whether real-time updates are active (either SSE or polling).
   */
  isConnected: boolean;

  /**
   * Whether we're in fallback polling mode.
   */
  isPolling: boolean;

  /**
   * Manually trigger a reconnection attempt.
   */
  reconnect: () => void;
}

// ============================================================================
// Constants
// ============================================================================

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
 * Polling interval when in fallback mode (30 seconds).
 */
const POLL_INTERVAL_MS = 30_000;

/**
 * How often to retry SSE while in polling mode (60 seconds).
 */
const SSE_RETRY_INTERVAL_MS = 60_000;

// ============================================================================
// SSE Event Parsing
// ============================================================================

/**
 * Parses SSE event data from a JSON string into a SyncEvent.
 * Uses the shared Zod schema for validation, which strips extra server fields
 * (userId, feedId) and applies defaults for optional fields like timestamp.
 * Returns null if the data is invalid or doesn't match a known event type.
 */
function parseEventData(data: string): SyncEvent | null {
  try {
    const result = syncEventSchema.safeParse(JSON.parse(data));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

// ============================================================================
// Hook
// ============================================================================

/**
 * Hook to manage real-time updates with SSE primary and polling fallback.
 *
 * @param initialCursors - Initial sync cursors from server (one per entity type)
 *
 * @example
 * ```tsx
 * function AppLayout({ children }) {
 *   // Get initial cursors from server or use null for initial sync
 *   const initialCursors: SyncCursors = { entries: null, subscriptions: null, tags: null };
 *   const { status, isConnected, isPolling } = useRealtimeUpdates(initialCursors);
 *
 *   return (
 *     <div>
 *       {isPolling && <PollingModeBanner />}
 *       {!isConnected && <ReconnectingBanner />}
 *       {children}
 *     </div>
 *   );
 * }
 * ```
 */
export function useRealtimeUpdates(initialCursors: SyncCursors): UseRealtimeUpdatesResult {
  const utils = trpc.useUtils();
  const queryClient = useQueryClient();

  // Connection status state
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("disconnected");
  const [isPollingMode, setIsPollingMode] = useState(false);

  // Refs to persist across renders
  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const sseRetryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectDelayRef = useRef(INITIAL_RECONNECT_DELAY_MS);
  const isManuallyClosedRef = useRef(false);
  const shouldConnectRef = useRef(false);
  // Initialize with server-provided cursors (granular tracking per entity type)
  const cursorsRef = useRef<SyncCursors>(initialCursors);

  // State to trigger reconnection
  const [reconnectTrigger, setReconnectTrigger] = useState(0);

  // Check if user is authenticated
  const userQuery = trpc.auth.me.useQuery(undefined, {
    retry: false,
    refetchOnWindowFocus: false,
  });

  const isAuthenticated = userQuery.isSuccess && userQuery.data?.user;

  /**
   * Cleans up all connections and intervals.
   */
  const cleanup = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }

    if (sseRetryTimeoutRef.current) {
      clearTimeout(sseRetryTimeoutRef.current);
      sseRetryTimeoutRef.current = null;
    }

    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
  }, []);

  /**
   * Updates the appropriate cursor based on the event type.
   * Only updates if the new timestamp is greater than the current cursor.
   */
  const updateCursorForEvent = useCallback((event: SyncEvent) => {
    let cursorType: "entries" | "subscriptions" | "tags" | null = null;

    if (
      event.type === "new_entry" ||
      event.type === "entry_updated" ||
      event.type === "entry_state_changed"
    ) {
      cursorType = "entries";
    } else if (
      event.type === "subscription_created" ||
      event.type === "subscription_updated" ||
      event.type === "subscription_deleted"
    ) {
      cursorType = "subscriptions";
    } else if (
      event.type === "tag_created" ||
      event.type === "tag_updated" ||
      event.type === "tag_deleted"
    ) {
      cursorType = "tags";
    }

    if (cursorType) {
      const currentCursor = cursorsRef.current[cursorType];
      if (!currentCursor || new Date(event.updatedAt) > new Date(currentCursor)) {
        cursorsRef.current = {
          ...cursorsRef.current,
          [cursorType]: event.updatedAt,
        };
      }
    }
  }, []);

  /**
   * Handles incoming SSE events by updating or invalidating relevant caches.
   * Uses the shared handleSyncEvent function for unified event handling.
   *
   * Also updates the appropriate cursor based on the event's updatedAt field
   * to keep cursors in sync as events arrive.
   */
  const handleEvent = useCallback(
    (event: MessageEvent) => {
      const data = parseEventData(event.data);
      if (!data) return;

      // Update the appropriate cursor based on event type
      updateCursorForEvent(data);

      // Delegate to shared handler for cache updates
      handleSyncEvent(utils, queryClient, data);
    },
    [utils, queryClient, updateCursorForEvent]
  );

  /**
   * Performs a sync to catch up on missed changes.
   * Uses the sync.events endpoint which returns events in the same format as SSE,
   * allowing us to reuse the same handleSyncEvent logic for both paths.
   * Used during polling mode and for catch-up sync after SSE reconnection.
   */
  const performSync = useCallback(async () => {
    try {
      const currentCursors = cursorsRef.current;

      const result = await utils.client.sync.events.query({
        cursors: {
          entries: currentCursors.entries ?? undefined,
          subscriptions: currentCursors.subscriptions ?? undefined,
          tags: currentCursors.tags ?? undefined,
        },
      });

      // Process each event through the shared handler (same as SSE path)
      for (const event of result.events) {
        updateCursorForEvent(event);
        handleSyncEvent(utils, queryClient, event);
      }

      // If there are more events, schedule another sync soon
      if (result.hasMore) {
        // Use setTimeout to avoid blocking - the next poll or manual sync will pick up more
        setTimeout(() => performSync(), 100);
      }

      return cursorsRef.current;
    } catch (error) {
      console.error("Sync failed:", error);
      return null;
    }
  }, [utils, queryClient, updateCursorForEvent]);

  /**
   * Starts polling mode when SSE is unavailable.
   */
  const startPolling = useCallback(() => {
    if (pollIntervalRef.current) {
      return; // Already polling
    }

    setIsPollingMode(true);
    setConnectionStatus("polling");

    // cursorsRef already initialized with server-provided cursors

    // Start polling interval
    pollIntervalRef.current = setInterval(() => {
      performSync();
    }, POLL_INTERVAL_MS);

    // Do an immediate sync
    performSync();
  }, [performSync]);

  /**
   * Stops polling mode.
   */
  const stopPolling = useCallback(() => {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
    setIsPollingMode(false);
  }, []);

  /**
   * Schedules a reconnection attempt with exponential backoff.
   */
  const scheduleReconnect = useCallback((connectFn: () => void) => {
    if (isManuallyClosedRef.current || !shouldConnectRef.current) return;

    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
    }

    const delay = reconnectDelayRef.current;

    reconnectTimeoutRef.current = setTimeout(() => {
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

    cleanup();
    stopPolling();

    setReconnectTrigger((prev) => prev + 1);
  }, [cleanup, stopPolling]);

  // Effect to manage SSE connection based on authentication
  useEffect(() => {
    shouldConnectRef.current = !!isAuthenticated;

    if (!isAuthenticated) {
      isManuallyClosedRef.current = true;
      cleanup();
      stopPolling();
      return;
    }

    // Already connected, nothing to do
    if (eventSourceRef.current?.readyState === EventSource.OPEN) {
      return;
    }

    // Clean up any existing connection
    cleanup();
    isManuallyClosedRef.current = false;

    const createConnection = async () => {
      if (!shouldConnectRef.current || isManuallyClosedRef.current) {
        return;
      }

      setConnectionStatus("connecting");

      try {
        // First, try a fetch to check if SSE is available
        // This handles the 503 case where Redis is down
        const response = await fetch("/api/v1/events", {
          method: "GET",
          credentials: "include",
          headers: {
            Accept: "text/event-stream",
          },
        });

        // If we get a 503, switch to polling mode
        if (response.status === 503) {
          console.log("SSE unavailable (503), switching to polling mode");
          startPolling();

          // Schedule periodic SSE retry
          sseRetryTimeoutRef.current = setTimeout(() => {
            if (shouldConnectRef.current && !isManuallyClosedRef.current) {
              stopPolling();
              createConnection();
            }
          }, SSE_RETRY_INTERVAL_MS);

          return;
        }

        // If not OK, treat as error
        if (!response.ok) {
          throw new Error(`SSE request failed with status ${response.status}`);
        }

        // Close the fetch response since we'll use EventSource
        // The fetch was just to check availability
        response.body?.cancel();

        // Create EventSource connection
        const eventSource = new EventSource("/api/v1/events", {
          withCredentials: true,
        });

        eventSourceRef.current = eventSource;

        eventSource.onopen = () => {
          setConnectionStatus("connected");
          reconnectDelayRef.current = INITIAL_RECONNECT_DELAY_MS;

          // Stop polling if we were in polling mode
          stopPolling();

          // Clear SSE retry timeout
          if (sseRetryTimeoutRef.current) {
            clearTimeout(sseRetryTimeoutRef.current);
            sseRetryTimeoutRef.current = null;
          }

          // Perform a catch-up sync to get any changes we might have missed
          // The cursorsRef is already initialized, so performSync will work correctly
          performSync();
        };

        // Handle named events
        eventSource.addEventListener("connected", handleEvent); // Initial cursor from server
        eventSource.addEventListener("new_entry", handleEvent);
        eventSource.addEventListener("entry_updated", handleEvent);
        eventSource.addEventListener("entry_state_changed", handleEvent);
        eventSource.addEventListener("subscription_created", handleEvent);
        eventSource.addEventListener("subscription_updated", handleEvent);
        eventSource.addEventListener("subscription_deleted", handleEvent);
        eventSource.addEventListener("tag_created", handleEvent);
        eventSource.addEventListener("tag_updated", handleEvent);
        eventSource.addEventListener("tag_deleted", handleEvent);
        eventSource.addEventListener("import_progress", handleEvent);
        eventSource.addEventListener("import_completed", handleEvent);

        eventSource.onerror = () => {
          if (eventSourceRef.current?.readyState === EventSource.CLOSED) {
            setConnectionStatus("error");
            cleanup();
            scheduleReconnect(createConnection);
          } else {
            setConnectionStatus("connecting");
          }
        };
      } catch (error) {
        console.error("Failed to create SSE connection:", error);
        setConnectionStatus("error");

        // On connection failure, try polling as fallback
        startPolling();

        // Schedule SSE retry
        sseRetryTimeoutRef.current = setTimeout(() => {
          if (shouldConnectRef.current && !isManuallyClosedRef.current) {
            stopPolling();
            createConnection();
          }
        }, SSE_RETRY_INTERVAL_MS);
      }
    };

    createConnection();

    return () => {
      isManuallyClosedRef.current = true;
      cleanup();
      stopPolling();
    };
  }, [
    isAuthenticated,
    reconnectTrigger,
    cleanup,
    handleEvent,
    scheduleReconnect,
    startPolling,
    stopPolling,
    performSync,
  ]);

  // Handle visibility change - reconnect when tab becomes visible
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (
        document.visibilityState === "visible" &&
        isAuthenticated &&
        eventSourceRef.current?.readyState !== EventSource.OPEN
      ) {
        // If in polling mode, do an immediate sync
        if (isPollingMode) {
          performSync();
        } else {
          reconnect();
        }
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [isAuthenticated, isPollingMode, performSync, reconnect]);

  // Derive the effective status
  const effectiveStatus: ConnectionStatus = isAuthenticated ? connectionStatus : "disconnected";

  return {
    status: effectiveStatus,
    isConnected: effectiveStatus === "connected" || effectiveStatus === "polling",
    isPolling: isPollingMode,
    reconnect,
  };
}

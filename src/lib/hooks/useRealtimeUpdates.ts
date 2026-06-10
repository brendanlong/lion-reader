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
 *
 * All connection-management decisions (when to reconnect, when to fall back to
 * polling, backoff progression) live in the pure state machine in
 * `src/lib/events/connection-state.ts`. This hook is the glue that feeds
 * browser events into the machine and executes the actions it returns against
 * the browser APIs (EventSource, fetch, timers).
 */

"use client";

import { useEffect, useRef, useCallback, useState, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { trpc } from "@/lib/trpc/client";
import { handleSyncEvent } from "@/lib/cache/event-handlers";
import {
  connectionStatusForPhase,
  INITIAL_CONNECTION_STATE,
  transition,
  type ConnectionAction,
  type ConnectionEvent,
  type ConnectionState,
  type ConnectionStatus,
} from "@/lib/events/connection-state";
import { advanceCursors, type SyncCursors } from "@/lib/events/cursors";
import { parseSyncEvent } from "@/lib/events/parse";
import {
  INITIAL_SYNC_SCHEDULER_STATE,
  reduceSyncScheduler,
  type SyncSchedulerEvent,
  type SyncSchedulerState,
} from "@/lib/events/sync-scheduler";

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

/**
 * Named SSE events forwarded to the shared sync-event handler.
 * "connected" is the initial cursor event from the server.
 */
const SSE_EVENT_NAMES = [
  "connected",
  "new_entry",
  "entry_updated",
  "entry_state_changed",
  "subscription_created",
  "subscription_updated",
  "subscription_deleted",
  "tag_created",
  "tag_updated",
  "tag_deleted",
  "import_progress",
  "import_completed",
] as const;

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

  const [state, setState] = useState<ConnectionState>(INITIAL_CONNECTION_STATE);

  // Refs to persist across renders
  const stateRef = useRef<ConnectionState>(state);
  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const sseRetryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Initialize with server-provided cursors (granular tracking per entity type)
  const cursorsRef = useRef<SyncCursors>(initialCursors);

  // Latest callbacks, readable from the stable dispatch closure below
  const handleEventRef = useRef<(event: MessageEvent) => void>(() => {});
  const requestSyncRef = useRef<() => void>(() => {});

  // Serializes catch-up syncs so two never run at once and double-apply
  // delta-based cache updates (#897). State is pure; the glue below executes it.
  const syncSchedulerStateRef = useRef<SyncSchedulerState>(INITIAL_SYNC_SCHEDULER_STATE);

  // Check if user is authenticated
  const userQuery = trpc.auth.me.useQuery(undefined, {
    retry: false,
    refetchOnWindowFocus: false,
  });

  const isAuthenticated = userQuery.isSuccess && !!userQuery.data?.user;

  /**
   * Handles incoming SSE events by updating or invalidating relevant caches.
   * Uses the shared handleSyncEvent function for unified event handling.
   *
   * Also advances the appropriate cursor based on the event's updatedAt field
   * to keep cursors in sync as events arrive.
   */
  const handleEvent = useCallback(
    (event: MessageEvent) => {
      const data = parseSyncEvent(event.data);
      if (!data) return;

      cursorsRef.current = advanceCursors(cursorsRef.current, data);

      // Delegate to shared handler for cache updates
      handleSyncEvent(utils, queryClient, data);
    },
    [utils, queryClient]
  );
  useEffect(() => {
    handleEventRef.current = handleEvent;
  }, [handleEvent]);

  /**
   * Runs a single catch-up sync against the sync.events endpoint, which returns
   * events in the same format as SSE so we reuse the same handleSyncEvent logic
   * for both paths. Returns whether the server has more events to drain.
   *
   * This must never run concurrently with itself: two runs would read the same
   * cursors and double-apply delta-based cache updates (#897). Serialization is
   * handled by the scheduler glue below — always go through `requestSync`, never
   * call this directly.
   */
  const runSyncOnce = useCallback(async (): Promise<boolean> => {
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
        cursorsRef.current = advanceCursors(cursorsRef.current, event);
        handleSyncEvent(utils, queryClient, event);
      }

      return result.hasMore;
    } catch (error) {
      console.error("Sync failed:", error);
      return false;
    }
  }, [utils, queryClient]);

  /**
   * Serializes sync execution. Every sync trigger (poll tick, visibility,
   * catch-up on connect, hasMore continuation) goes through here so at most one
   * sync runs at a time; overlapping requests coalesce into a single follow-up
   * once the in-flight sync settles. See `sync-scheduler.ts` for the rationale.
   */
  const requestSync = useCallback(() => {
    function dispatchSchedulerEvent(event: SyncSchedulerEvent): void {
      const { state, startSync } = reduceSyncScheduler(syncSchedulerStateRef.current, event);
      syncSchedulerStateRef.current = state;
      if (startSync) {
        void runSyncOnce().then((hasMore) => {
          dispatchSchedulerEvent({ type: "completed", hasMore });
        });
      }
    }

    dispatchSchedulerEvent({ type: "request" });
  }, [runSyncOnce]);
  useEffect(() => {
    requestSyncRef.current = requestSync;
  }, [requestSync]);

  /**
   * Stable dispatcher: runs the pure transition function and executes the
   * resulting actions against browser APIs.
   */
  const dispatch = useMemo(() => {
    function dispatchEvent(event: ConnectionEvent): void {
      const { state: nextState, actions } = transition(stateRef.current, event);
      if (nextState !== stateRef.current) {
        stateRef.current = nextState;
        setState(nextState);
      }
      for (const action of actions) {
        runAction(action);
      }
    }

    function runAction(action: ConnectionAction): void {
      switch (action.type) {
        case "open-event-source":
          openEventSource();
          break;
        case "close-event-source":
          if (eventSourceRef.current) {
            eventSourceRef.current.close();
            eventSourceRef.current = null;
          }
          break;
        case "probe-availability":
          void probeAvailability();
          break;
        case "schedule-reconnect":
          if (reconnectTimeoutRef.current) {
            clearTimeout(reconnectTimeoutRef.current);
          }
          reconnectTimeoutRef.current = setTimeout(() => {
            reconnectTimeoutRef.current = null;
            dispatchEvent({ type: "reconnect-timer-fired" });
          }, action.delayMs);
          break;
        case "cancel-reconnect":
          if (reconnectTimeoutRef.current) {
            clearTimeout(reconnectTimeoutRef.current);
            reconnectTimeoutRef.current = null;
          }
          break;
        case "start-poll-interval":
          if (!pollIntervalRef.current) {
            pollIntervalRef.current = setInterval(() => {
              requestSyncRef.current();
            }, action.intervalMs);
          }
          break;
        case "stop-poll-interval":
          if (pollIntervalRef.current) {
            clearInterval(pollIntervalRef.current);
            pollIntervalRef.current = null;
          }
          break;
        case "schedule-sse-retry":
          if (sseRetryTimeoutRef.current) {
            clearTimeout(sseRetryTimeoutRef.current);
          }
          sseRetryTimeoutRef.current = setTimeout(() => {
            sseRetryTimeoutRef.current = null;
            dispatchEvent({ type: "sse-retry-timer-fired" });
          }, action.delayMs);
          break;
        case "cancel-sse-retry":
          if (sseRetryTimeoutRef.current) {
            clearTimeout(sseRetryTimeoutRef.current);
            sseRetryTimeoutRef.current = null;
          }
          break;
        case "sync":
          requestSyncRef.current();
          break;
      }
    }

    function openEventSource(): void {
      // Open the EventSource directly: a single connection per session.
      // SSE availability (the 503 case) is only checked on the error path,
      // so the happy path doesn't double the per-connect auth and DB work.
      const eventSource = new EventSource("/api/v1/events", {
        withCredentials: true,
      });

      eventSourceRef.current = eventSource;

      eventSource.onopen = () => {
        if (eventSourceRef.current !== eventSource) return;
        dispatchEvent({ type: "open" });
      };

      for (const eventName of SSE_EVENT_NAMES) {
        eventSource.addEventListener(eventName, (event) => handleEventRef.current(event));
      }

      eventSource.onerror = () => {
        if (eventSourceRef.current !== eventSource) return;
        dispatchEvent({
          type: "stream-error",
          closed: eventSource.readyState === EventSource.CLOSED,
        });
      };
    }

    /**
     * Decides how to recover after the EventSource fails. A lightweight HEAD
     * request (no auth/DB work server-side) distinguishes "SSE unavailable"
     * (503, e.g. Redis down) — fall back to polling — from other failures,
     * which get the normal reconnect backoff.
     */
    async function probeAvailability(): Promise<void> {
      let sseUnavailable = false;
      try {
        const response = await fetch("/api/v1/events", {
          method: "HEAD",
          credentials: "include",
        });
        sseUnavailable = response.status === 503;
      } catch {
        // Network error - treat like any other failure (reconnect backoff)
      }

      if (sseUnavailable) {
        console.log("SSE unavailable (503), switching to polling mode");
      }
      dispatchEvent({ type: "probe-result", sseUnavailable });
    }

    return dispatchEvent;
  }, []);

  /**
   * Manual reconnection function exposed to consumers.
   */
  const reconnect = useCallback(() => {
    dispatch({ type: "manual-reconnect" });
  }, [dispatch]);

  // Effect to manage the connection based on authentication
  useEffect(() => {
    if (!isAuthenticated) {
      dispatch({ type: "disconnect" });
      return;
    }

    dispatch({ type: "connect" });

    return () => {
      dispatch({ type: "disconnect" });
    };
  }, [isAuthenticated, dispatch]);

  // Handle visibility change - reconnect (or sync, in polling mode) when the
  // tab becomes visible
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        dispatch({ type: "visibility-visible" });
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [dispatch]);

  const status = connectionStatusForPhase(state.phase);

  return {
    status,
    isConnected: status === "connected" || status === "polling",
    isPolling: state.phase === "polling",
    reconnect,
  };
}

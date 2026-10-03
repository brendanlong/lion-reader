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
 * `src/lib/events/connection-state.ts`, and all catch-up sync decisions
 * (cursors, the cursor freeze, retries) in `src/lib/events/sync-session.ts`.
 * This hook is the glue that feeds browser events into them and executes the
 * actions they return against the browser APIs (EventSource, fetch, timers).
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
import type { SyncCursors } from "@/lib/events/cursors";
import { parseSyncEvent } from "@/lib/events/parse";
import {
  initialSyncSession,
  reduceSyncSession,
  type SyncSessionAction,
  type SyncSessionEvent,
  type SyncSessionState,
} from "@/lib/events/sync-session";

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
   * Manually trigger a reconnection attempt.
   */
  reconnect: () => void;
}

/**
 * Named SSE events forwarded to the shared sync-event handler. These are
 * exactly the members of `syncEventSchema`; the connection state itself
 * (open/error) is tracked via the EventSource's own onopen/onerror, not a
 * data event.
 */
const SSE_EVENT_NAMES = [
  "new_entry",
  "entry_updated",
  "entry_state_changed",
  "mark_all_read",
  "subscription_created",
  "subscription_updated",
  "subscription_deleted",
  "tag_created",
  "tag_updated",
  "tag_deleted",
  "import_progress",
  "import_completed",
  "announcement_changed",
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
 *   const initialCursors: SyncCursors = { entries: null, entriesAfterId: null, subscriptions: null, tags: null };
 *   const { status, reconnect } = useRealtimeUpdates(initialCursors);
 *
 *   return (
 *     <div>
 *       {children}
 *       <ConnectionStatusIndicator status={status} onReconnect={reconnect} />
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
  const syncRetryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Seeded with the server-provided cursors (one per entity type)
  const syncSessionRef = useRef<SyncSessionState | null>(null);
  if (syncSessionRef.current === null) syncSessionRef.current = initialSyncSession(initialCursors);

  // The latest sync dispatcher, readable from the stable connection dispatcher below
  const dispatchSyncRef = useRef<(event: SyncSessionEvent) => void>(() => {});

  // Check if user is authenticated
  const userQuery = trpc.auth.me.useQuery(undefined, {
    retry: false,
    refetchOnWindowFocus: false,
  });

  const isAuthenticated = userQuery.isSuccess && !!userQuery.data?.user;

  /**
   * Runs the pure sync-session reducer and executes the actions it returns:
   * `sync.events` queries (whose events go through the same handleSyncEvent
   * as live SSE events) and the catch-up retry timer.
   */
  const dispatchSync = useMemo(() => {
    function dispatch(event: SyncSessionEvent): void {
      const { state: nextState, actions } = reduceSyncSession(syncSessionRef.current!, event);
      syncSessionRef.current = nextState;
      for (const action of actions) runAction(action);
    }

    function runAction(action: SyncSessionAction): void {
      switch (action.type) {
        case "run-sync":
          void runSync(action);
          break;
        case "schedule-retry":
          if (syncRetryTimeoutRef.current) clearTimeout(syncRetryTimeoutRef.current);
          syncRetryTimeoutRef.current = setTimeout(() => {
            syncRetryTimeoutRef.current = null;
            dispatch({ type: "retry-fired" });
          }, action.delayMs);
          break;
        case "cancel-retry":
          if (syncRetryTimeoutRef.current) {
            clearTimeout(syncRetryTimeoutRef.current);
            syncRetryTimeoutRef.current = null;
          }
          break;
      }
    }

    async function runSync(action: Extract<SyncSessionAction, { type: "run-sync" }>) {
      let result: SyncSessionEvent;
      try {
        const { events, hasMore } = await utils.client.sync.events.query({
          cursors: action.cursors,
        });
        for (const event of events) handleSyncEvent(utils, queryClient, event);
        result = { type: "sync-result", epoch: action.epoch, ok: true, events, hasMore };
      } catch (error) {
        console.error("Sync failed:", error);
        result = { type: "sync-result", epoch: action.epoch, ok: false };
      }
      dispatch(result);
    }

    return dispatch;
  }, [utils, queryClient]);
  useEffect(() => {
    dispatchSyncRef.current = dispatchSync;
  }, [dispatchSync]);

  /** Handles a live SSE event: cursor bookkeeping, then the shared cache handler. */
  const handleEvent = useCallback(
    (event: MessageEvent) => {
      const data = parseSyncEvent(event.data);
      if (!data) return;
      dispatchSync({ type: "live-event", event: data });
      handleSyncEvent(utils, queryClient, data);
    },
    [dispatchSync, utils, queryClient]
  );
  const handleEventRef = useRef<(event: MessageEvent) => void>(() => {});
  useEffect(() => {
    handleEventRef.current = handleEvent;
  }, [handleEvent]);

  /**
   * Stable dispatcher: runs the pure transition function and executes the
   * resulting actions against browser APIs.
   */
  const dispatch = useMemo(() => {
    function dispatchEvent(event: ConnectionEvent): void {
      const { state: nextState, actions } = transition(stateRef.current, event);
      if (nextState !== stateRef.current) {
        if (nextState.phase === "disconnected") dispatchSyncRef.current({ type: "disconnected" });
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
              dispatchSyncRef.current({ type: "sync-requested" });
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
          dispatchSyncRef.current({ type: "sync-requested" });
          break;
      }
    }

    function openEventSource(): void {
      // A new connection opens a fresh (possibly empty) gap.
      dispatchSyncRef.current({ type: "connection-opened" });

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
        // Any stream error opens a potential gap — including the browser's own
        // silent auto-reconnect (which reuses this EventSource and fires onopen
        // again without going through openEventSource).
        dispatchSyncRef.current({ type: "stream-error" });
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

  return {
    status: connectionStatusForPhase(state.phase),
    reconnect,
  };
}

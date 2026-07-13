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
 * Named SSE events forwarded to the shared sync-event handler. These are
 * exactly the members of `syncEventSchema`; the connection state itself
 * (open/error) is tracked via the EventSource's own onopen/onerror, not a
 * data event.
 */
/**
 * Backoff bounds for retrying a failed catch-up sync while the SSE stream is
 * connected (the polling phase already retries every POLL_INTERVAL_MS). Without
 * this, a catch-up sync that fails on SSE `open` is never retried, so changes
 * from other devices in the disconnected window stay wrong on an idle view
 * (#1081).
 */
const INITIAL_SYNC_RETRY_DELAY_MS = 2_000;
const MAX_SYNC_RETRY_DELAY_MS = 30_000;

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
  const syncRetryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const syncRetryDelayRef = useRef<number>(INITIAL_SYNC_RETRY_DELAY_MS);
  // Initialize with server-provided cursors (granular tracking per entity type)
  const cursorsRef = useRef<SyncCursors>(initialCursors);

  // Whether the catch-up sync after the current connection opened has fully
  // succeeded. While this is false (freshly (re)connected, or a catch-up sync is
  // still failing/draining), live SSE events must NOT advance the persisted sync
  // cursor: doing so would push the cursor past a not-yet-synced gap, making the
  // pending catch-up query skip the gap's rows forever (#1081). The cache is
  // still patched live regardless; only the cursor is frozen.
  const caughtUpRef = useRef<boolean>(false);

  // Monotonic generation bumped every time the cursor is frozen (a new/errored
  // connection). A catch-up sync captures the epoch when it starts and may only
  // mark caught-up if the epoch is unchanged when it settles — i.e. no freeze
  // happened in between. Without this, a sync started by a now-superseded
  // connection could resolve (while the current connection's catch-up hasn't
  // even been requested yet) and un-freeze the cursor prematurely, re-opening
  // the very gap this closes (#1081).
  const syncEpochRef = useRef<number>(0);

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

      // Only advance the persisted sync cursor from live events once the
      // post-connect catch-up sync has succeeded. Before then the cursor must
      // stay pinned at the pre-gap position so a still-pending (or retrying)
      // catch-up query returns the disconnected-window rows instead of skipping
      // them (#1081). The cache is patched live either way.
      if (caughtUpRef.current) {
        cursorsRef.current = advanceCursors(cursorsRef.current, data);
      }

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
   *
   * Returns `{ ok, hasMore }`: `ok` is false when the request failed (so the
   * caller schedules a backoff retry and keeps the cursor frozen); `hasMore`
   * mirrors the server's drain flag.
   */
  const runSyncOnce = useCallback(async (): Promise<{ ok: boolean; hasMore: boolean }> => {
    try {
      const currentCursors = cursorsRef.current;

      const result = await utils.client.sync.events.query({
        cursors: {
          entries: currentCursors.entries ?? undefined,
          entriesAfterId: currentCursors.entriesAfterId ?? undefined,
          subscriptions: currentCursors.subscriptions ?? undefined,
          tags: currentCursors.tags ?? undefined,
        },
      });

      // Process each event through the shared handler (same as SSE path). The
      // catch-up sync always advances the cursor — it drains the authoritative
      // server sequence, unlike live events which are gated by caughtUpRef.
      for (const event of result.events) {
        cursorsRef.current = advanceCursors(cursorsRef.current, event);
        handleSyncEvent(utils, queryClient, event);
      }

      return { ok: true, hasMore: result.hasMore };
    } catch (error) {
      console.error("Sync failed:", error);
      return { ok: false, hasMore: false };
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
      // Don't start or continue syncs once disconnected (unmount/logout sets
      // this synchronously). Otherwise an in-flight sync's `hasMore` drain would
      // keep firing background sync.events requests after the hook is gone. This
      // guards both the initial `request` and the `completed` re-entry below.
      // Reset to idle so a later reconnect's catch-up sync starts cleanly
      // instead of being stuck behind an abandoned `running` flag.
      if (stateRef.current.phase === "disconnected") {
        syncSchedulerStateRef.current = INITIAL_SYNC_SCHEDULER_STATE;
        // Drop any pending catch-up retry so it can't fire after disconnect.
        if (syncRetryTimeoutRef.current) {
          clearTimeout(syncRetryTimeoutRef.current);
          syncRetryTimeoutRef.current = null;
        }
        syncRetryDelayRef.current = INITIAL_SYNC_RETRY_DELAY_MS;
        return;
      }
      const { state, startSync } = reduceSyncScheduler(syncSchedulerStateRef.current, event);
      syncSchedulerStateRef.current = state;
      if (startSync) {
        // Capture the connection epoch this sync starts under; only un-freeze if
        // no freeze (reconnect/stream-error) happened before it settled.
        const syncEpoch = syncEpochRef.current;
        void runSyncOnce().then((result) => {
          if (result.ok) {
            // Success: cancel any pending retry and reset the backoff.
            if (syncRetryTimeoutRef.current) {
              clearTimeout(syncRetryTimeoutRef.current);
              syncRetryTimeoutRef.current = null;
            }
            syncRetryDelayRef.current = INITIAL_SYNC_RETRY_DELAY_MS;
            // Un-freeze the cursor only when this sync fully drained, no
            // follow-up is queued (the scheduler is settling to idle), AND the
            // epoch is unchanged (no reconnect/stream-error opened a fresh gap
            // while this sync ran, and this sync belongs to the current
            // connection — not a superseded one whose late success would
            // un-freeze past the current connection's not-yet-drained gap).
            // Otherwise the queued follow-up / next connection's catch-up marks
            // caught-up when it settles cleanly (#1081).
            if (
              !result.hasMore &&
              !syncSchedulerStateRef.current.pending &&
              syncEpoch === syncEpochRef.current
            ) {
              caughtUpRef.current = true;
            }
          } else {
            // Failure: retry with backoff. The cursor stays frozen (caughtUp is
            // still false) so the retry re-queries the same unsynced gap.
            scheduleSyncRetry();
          }
          // Report to the scheduler as not-more on failure so it settles to idle
          // (or runs a queued follow-up); the backoff timer drives the retry.
          dispatchSchedulerEvent({ type: "completed", hasMore: result.ok && result.hasMore });
        });
      }
    }

    /**
     * Schedules a backoff retry of the catch-up sync after a failure. Coalesces
     * with the scheduler, so a retry that lands while another sync is running
     * just queues a single follow-up. No-ops once disconnected.
     */
    function scheduleSyncRetry(): void {
      if (syncRetryTimeoutRef.current) {
        clearTimeout(syncRetryTimeoutRef.current);
      }
      const delay = syncRetryDelayRef.current;
      syncRetryDelayRef.current = Math.min(delay * 2, MAX_SYNC_RETRY_DELAY_MS);
      syncRetryTimeoutRef.current = setTimeout(() => {
        syncRetryTimeoutRef.current = null;
        if (stateRef.current.phase === "disconnected") return;
        requestSyncRef.current();
      }, delay);
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
      // A new connection opens a fresh (possibly empty) gap: freeze the cursor
      // until this connection's catch-up sync succeeds, and bump the epoch so an
      // in-flight sync from the previous connection can't mark us caught-up
      // (#1081).
      caughtUpRef.current = false;
      syncEpochRef.current += 1;

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
        // again without going through openEventSource). Freeze the cursor (and
        // bump the epoch) so the next catch-up covers whatever was missed and no
        // in-flight sync from before the error can mark us caught-up (#1081).
        caughtUpRef.current = false;
        syncEpochRef.current += 1;
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

  // Clear the catch-up retry timer on unmount (the connection machine's
  // teardown handles the reconnect/poll/SSE-retry timers, but the sync retry is
  // hook glue outside the machine).
  useEffect(() => {
    return () => {
      if (syncRetryTimeoutRef.current) {
        clearTimeout(syncRetryTimeoutRef.current);
        syncRetryTimeoutRef.current = null;
      }
    };
  }, []);

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

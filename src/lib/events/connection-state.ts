/**
 * Realtime Connection State Machine
 *
 * Pure decision logic for the realtime-updates connection lifecycle:
 * SSE connection, exponential-backoff reconnection, and the polling fallback
 * used when SSE is unavailable (e.g. Redis down).
 *
 * `transition(state, event)` returns the next state plus a list of actions for
 * the caller (useRealtimeUpdates) to execute against the browser APIs
 * (EventSource, fetch, timers). Keeping this pure makes the reconnect/backoff/
 * fallback behavior unit-testable without mocking browser APIs.
 *
 * Phases:
 * - "disconnected": not connected and not trying (unauthenticated/unmounted)
 * - "connecting": an EventSource is open(ing), waiting for the open event
 * - "connected": SSE stream is live
 * - "probing": the stream died; a HEAD request is in flight to distinguish
 *   "SSE unavailable" (503 -> polling) from transient failures (-> backoff)
 * - "backoff": waiting on the exponential-backoff timer before reconnecting
 * - "polling": SSE unavailable; polling the sync endpoint, periodically
 *   retrying SSE
 */

// ============================================================================
// Constants
// ============================================================================

/** Initial reconnection delay in milliseconds (1 second). */
export const INITIAL_RECONNECT_DELAY_MS = 1_000;

/** Maximum reconnection delay in milliseconds (30 seconds). */
export const MAX_RECONNECT_DELAY_MS = 30_000;

/** Backoff multiplier for exponential backoff. */
const BACKOFF_MULTIPLIER = 2;

/** Polling interval when in fallback mode (30 seconds). */
export const POLL_INTERVAL_MS = 30_000;

/** How often to retry SSE while in polling mode (60 seconds). */
export const SSE_RETRY_INTERVAL_MS = 60_000;

// ============================================================================
// Types
// ============================================================================

/**
 * Connection status for real-time updates, as exposed to the UI.
 */
export type ConnectionStatus = "connecting" | "connected" | "disconnected" | "error" | "polling";

export type ConnectionPhase =
  | "disconnected"
  | "connecting"
  | "connected"
  | "probing"
  | "backoff"
  | "polling";

export interface ConnectionState {
  phase: ConnectionPhase;
  /**
   * Delay to use for the next scheduled reconnect attempt. Doubles (up to
   * MAX_RECONNECT_DELAY_MS) each time the backoff timer fires; resets to
   * INITIAL_RECONNECT_DELAY_MS on a successful open or a manual reconnect.
   */
  reconnectDelayMs: number;
}

export const INITIAL_CONNECTION_STATE: ConnectionState = {
  phase: "disconnected",
  reconnectDelayMs: INITIAL_RECONNECT_DELAY_MS,
};

/**
 * Events fed into the state machine by the hook glue.
 */
export type ConnectionEvent =
  /** Authentication became available (or the hook mounted while authenticated). */
  | { type: "connect" }
  /** User clicked "Retry", or the tab became visible while not connected. */
  | { type: "manual-reconnect" }
  /** The EventSource fired its open event. */
  | { type: "open" }
  /**
   * The EventSource fired its error event. `closed` is true when the browser
   * gave up (readyState CLOSED); false means the browser is auto-reconnecting.
   */
  | { type: "stream-error"; closed: boolean }
  /**
   * Result of the HEAD availability probe after a closed stream.
   * `sseUnavailable` is true for a 503 response (e.g. Redis down); false for
   * any other response or a network error.
   */
  | { type: "probe-result"; sseUnavailable: boolean }
  /** The exponential-backoff reconnect timer fired. */
  | { type: "reconnect-timer-fired" }
  /** The periodic retry-SSE-while-polling timer fired. */
  | { type: "sse-retry-timer-fired" }
  /** The tab became visible. */
  | { type: "visibility-visible" }
  /** Authentication was lost or the hook unmounted. */
  | { type: "disconnect" };

/**
 * Side effects for the hook glue to execute, in order.
 */
export type ConnectionAction =
  | { type: "open-event-source" }
  | { type: "close-event-source" }
  /** Issue the HEAD request that distinguishes 503 from other failures. */
  | { type: "probe-availability" }
  | { type: "schedule-reconnect"; delayMs: number }
  | { type: "cancel-reconnect" }
  | { type: "start-poll-interval"; intervalMs: number }
  | { type: "stop-poll-interval" }
  | { type: "schedule-sse-retry"; delayMs: number }
  | { type: "cancel-sse-retry" }
  /** Run a catch-up sync against the sync endpoint. */
  | { type: "sync" };

export interface TransitionResult {
  state: ConnectionState;
  actions: ConnectionAction[];
}

// ============================================================================
// Pure helpers
// ============================================================================

/**
 * Exponential backoff: doubles the delay, capped at MAX_RECONNECT_DELAY_MS.
 */
export function nextReconnectDelay(currentDelayMs: number): number {
  return Math.min(currentDelayMs * BACKOFF_MULTIPLIER, MAX_RECONNECT_DELAY_MS);
}

/**
 * Maps a machine phase to the ConnectionStatus exposed to the UI.
 */
export function connectionStatusForPhase(phase: ConnectionPhase): ConnectionStatus {
  switch (phase) {
    case "disconnected":
      return "disconnected";
    case "connecting":
      return "connecting";
    case "connected":
      return "connected";
    case "probing":
    case "backoff":
      return "error";
    case "polling":
      return "polling";
  }
}

// ============================================================================
// Transition function
// ============================================================================

/** Tear down everything before (re)opening a connection. */
const TEARDOWN_ACTIONS: ConnectionAction[] = [
  { type: "close-event-source" },
  { type: "cancel-reconnect" },
  { type: "cancel-sse-retry" },
  { type: "stop-poll-interval" },
];

function ignore(state: ConnectionState): TransitionResult {
  return { state, actions: [] };
}

/**
 * Computes the next state and side effects for a connection event.
 *
 * Events that don't apply to the current phase (e.g. a probe result arriving
 * after a manual reconnect already started a new connection) are ignored,
 * returning the same state reference and no actions.
 */
export function transition(state: ConnectionState, event: ConnectionEvent): TransitionResult {
  switch (event.type) {
    case "connect":
      // Already connected: nothing to do.
      if (state.phase === "connected") {
        return ignore(state);
      }
      return {
        state: { ...state, phase: "connecting" },
        actions: [...TEARDOWN_ACTIONS, { type: "open-event-source" }],
      };

    case "manual-reconnect":
      // Can't connect while unauthenticated/unmounted.
      if (state.phase === "disconnected") {
        return ignore(state);
      }
      return {
        state: { phase: "connecting", reconnectDelayMs: INITIAL_RECONNECT_DELAY_MS },
        actions: [...TEARDOWN_ACTIONS, { type: "open-event-source" }],
      };

    case "open":
      if (state.phase !== "connecting") {
        return ignore(state);
      }
      return {
        state: { phase: "connected", reconnectDelayMs: INITIAL_RECONNECT_DELAY_MS },
        actions: [
          { type: "stop-poll-interval" },
          { type: "cancel-sse-retry" },
          // Catch-up sync for anything missed while disconnected.
          { type: "sync" },
        ],
      };

    case "stream-error":
      if (state.phase !== "connecting" && state.phase !== "connected") {
        return ignore(state);
      }
      if (!event.closed) {
        // The browser is auto-reconnecting the EventSource.
        return { state: { ...state, phase: "connecting" }, actions: [] };
      }
      return {
        state: { ...state, phase: "probing" },
        actions: [...TEARDOWN_ACTIONS, { type: "probe-availability" }],
      };

    case "probe-result":
      if (state.phase !== "probing") {
        return ignore(state);
      }
      if (event.sseUnavailable) {
        return {
          state: { ...state, phase: "polling" },
          actions: [
            { type: "start-poll-interval", intervalMs: POLL_INTERVAL_MS },
            { type: "sync" },
            { type: "schedule-sse-retry", delayMs: SSE_RETRY_INTERVAL_MS },
          ],
        };
      }
      return {
        state: { ...state, phase: "backoff" },
        actions: [{ type: "schedule-reconnect", delayMs: state.reconnectDelayMs }],
      };

    case "reconnect-timer-fired":
      if (state.phase !== "backoff") {
        return ignore(state);
      }
      return {
        state: {
          phase: "connecting",
          reconnectDelayMs: nextReconnectDelay(state.reconnectDelayMs),
        },
        actions: [{ type: "open-event-source" }],
      };

    case "sse-retry-timer-fired":
      if (state.phase !== "polling") {
        return ignore(state);
      }
      return {
        state: { ...state, phase: "connecting" },
        actions: [{ type: "stop-poll-interval" }, { type: "open-event-source" }],
      };

    case "visibility-visible":
      switch (state.phase) {
        case "connected":
        case "disconnected":
          return ignore(state);
        case "polling":
          // Stay in polling mode but sync immediately.
          return { state, actions: [{ type: "sync" }] };
        default:
          // Not connected: retry immediately with a fresh backoff.
          return transition(state, { type: "manual-reconnect" });
      }

    case "disconnect":
      if (state.phase === "disconnected") {
        return ignore(state);
      }
      return {
        state: { ...state, phase: "disconnected" },
        actions: TEARDOWN_ACTIONS,
      };
  }
}

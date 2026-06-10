/**
 * Unit tests for the realtime connection state machine.
 *
 * These cover the connection-management decisions that used to live tangled
 * inside useRealtimeUpdates: reconnection backoff, the polling fallback for
 * SSE-unavailable (503), recovery from polling back to SSE, catch-up sync on
 * (re)connect, and visibility-change handling.
 */

import { describe, it, expect } from "vitest";
import {
  connectionStatusForPhase,
  INITIAL_CONNECTION_STATE,
  INITIAL_RECONNECT_DELAY_MS,
  MAX_RECONNECT_DELAY_MS,
  nextReconnectDelay,
  POLL_INTERVAL_MS,
  SSE_RETRY_INTERVAL_MS,
  transition,
  type ConnectionAction,
  type ConnectionEvent,
  type ConnectionState,
} from "@/lib/events/connection-state";

/** Runs a sequence of events, returning the final state. */
function run(events: ConnectionEvent[], from: ConnectionState = INITIAL_CONNECTION_STATE) {
  let state = from;
  for (const event of events) {
    state = transition(state, event).state;
  }
  return state;
}

function actionTypes(actions: ConnectionAction[]): string[] {
  return actions.map((a) => a.type);
}

/** State after connect -> open: a healthy SSE connection. */
const CONNECTED_STATE = run([{ type: "connect" }, { type: "open" }]);

/** State after a closed stream error: probing for SSE availability. */
const PROBING_STATE = run([{ type: "stream-error", closed: true }], CONNECTED_STATE);

/** State after the probe reported SSE unavailable: polling fallback. */
const POLLING_STATE = run([{ type: "probe-result", sseUnavailable: true }], PROBING_STATE);

/** State after the probe reported a transient failure: backoff wait. */
const BACKOFF_STATE = run([{ type: "probe-result", sseUnavailable: false }], PROBING_STATE);

describe("nextReconnectDelay", () => {
  it("doubles the delay", () => {
    expect(nextReconnectDelay(1_000)).toBe(2_000);
    expect(nextReconnectDelay(8_000)).toBe(16_000);
  });

  it("caps at MAX_RECONNECT_DELAY_MS", () => {
    expect(nextReconnectDelay(16_000)).toBe(30_000);
    expect(nextReconnectDelay(MAX_RECONNECT_DELAY_MS)).toBe(MAX_RECONNECT_DELAY_MS);
  });
});

describe("connectionStatusForPhase", () => {
  it("maps phases to UI statuses", () => {
    expect(connectionStatusForPhase("disconnected")).toBe("disconnected");
    expect(connectionStatusForPhase("connecting")).toBe("connecting");
    expect(connectionStatusForPhase("connected")).toBe("connected");
    expect(connectionStatusForPhase("probing")).toBe("error");
    expect(connectionStatusForPhase("backoff")).toBe("error");
    expect(connectionStatusForPhase("polling")).toBe("polling");
  });
});

describe("connecting and opening", () => {
  it("connect opens an EventSource after tearing down any previous connection state", () => {
    const { state, actions } = transition(INITIAL_CONNECTION_STATE, { type: "connect" });
    expect(state.phase).toBe("connecting");
    expect(actionTypes(actions)).toEqual([
      "close-event-source",
      "cancel-reconnect",
      "cancel-sse-retry",
      "stop-poll-interval",
      "open-event-source",
    ]);
  });

  it("connect is a no-op when already connected", () => {
    const result = transition(CONNECTED_STATE, { type: "connect" });
    expect(result.state).toBe(CONNECTED_STATE);
    expect(result.actions).toEqual([]);
  });

  it("open triggers a catch-up sync and stops any polling fallback", () => {
    const connecting = run([{ type: "connect" }]);
    const { state, actions } = transition(connecting, { type: "open" });
    expect(state.phase).toBe("connected");
    expect(actionTypes(actions)).toEqual(["stop-poll-interval", "cancel-sse-retry", "sync"]);
  });
});

describe("reconnection backoff", () => {
  it("schedules the first reconnect with the initial delay after a transient failure", () => {
    const { state, actions } = transition(PROBING_STATE, {
      type: "probe-result",
      sseUnavailable: false,
    });
    expect(state.phase).toBe("backoff");
    expect(actions).toEqual([{ type: "schedule-reconnect", delayMs: INITIAL_RECONNECT_DELAY_MS }]);
  });

  it("doubles the delay on each failed attempt, capping at the max", () => {
    let state = INITIAL_CONNECTION_STATE;
    const observedDelays: number[] = [];

    for (let attempt = 0; attempt < 8; attempt++) {
      state = run(
        [
          { type: "connect" },
          { type: "stream-error", closed: true },
          { type: "probe-result", sseUnavailable: false },
        ],
        state
      );
      expect(state.phase).toBe("backoff");
      observedDelays.push(state.reconnectDelayMs);
      // Timer fires -> retry the connection with an increased next delay
      state = transition(state, { type: "reconnect-timer-fired" }).state;
      expect(state.phase).toBe("connecting");
    }

    expect(observedDelays).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000]);
  });

  it("resets the backoff delay after a successful open", () => {
    const backedOff = run(
      [
        { type: "connect" },
        { type: "stream-error", closed: true },
        { type: "probe-result", sseUnavailable: false },
        { type: "reconnect-timer-fired" },
      ],
      INITIAL_CONNECTION_STATE
    );
    expect(backedOff.reconnectDelayMs).toBeGreaterThan(INITIAL_RECONNECT_DELAY_MS);

    const opened = transition(backedOff, { type: "open" }).state;
    expect(opened.phase).toBe("connected");
    expect(opened.reconnectDelayMs).toBe(INITIAL_RECONNECT_DELAY_MS);
  });

  it("resets the backoff delay on manual reconnect", () => {
    const backedOff = run([{ type: "reconnect-timer-fired" }], {
      ...BACKOFF_STATE,
      reconnectDelayMs: 16_000,
    });
    const { state, actions } = transition(backedOff, { type: "manual-reconnect" });
    expect(state).toEqual({ phase: "connecting", reconnectDelayMs: INITIAL_RECONNECT_DELAY_MS });
    expect(actionTypes(actions)).toContain("open-event-source");
  });
});

describe("stream errors", () => {
  it("treats a non-closed error as the browser auto-reconnecting", () => {
    const { state, actions } = transition(CONNECTED_STATE, {
      type: "stream-error",
      closed: false,
    });
    expect(state.phase).toBe("connecting");
    expect(actions).toEqual([]);
  });

  it("probes SSE availability after a closed stream", () => {
    const { state, actions } = transition(CONNECTED_STATE, { type: "stream-error", closed: true });
    expect(state.phase).toBe("probing");
    expect(connectionStatusForPhase(state.phase)).toBe("error");
    expect(actionTypes(actions)).toEqual([
      "close-event-source",
      "cancel-reconnect",
      "cancel-sse-retry",
      "stop-poll-interval",
      "probe-availability",
    ]);
  });

  it("ignores stream errors from a stale EventSource while polling", () => {
    const result = transition(POLLING_STATE, { type: "stream-error", closed: true });
    expect(result.state).toBe(POLLING_STATE);
    expect(result.actions).toEqual([]);
  });
});

describe("polling fallback (SSE unavailable, 503)", () => {
  it("starts polling with an immediate sync and schedules an SSE retry", () => {
    const { state, actions } = transition(PROBING_STATE, {
      type: "probe-result",
      sseUnavailable: true,
    });
    expect(state.phase).toBe("polling");
    expect(actions).toEqual([
      { type: "start-poll-interval", intervalMs: POLL_INTERVAL_MS },
      { type: "sync" },
      { type: "schedule-sse-retry", delayMs: SSE_RETRY_INTERVAL_MS },
    ]);
  });

  it("retries SSE when the retry timer fires, stopping polling", () => {
    const { state, actions } = transition(POLLING_STATE, { type: "sse-retry-timer-fired" });
    expect(state.phase).toBe("connecting");
    expect(actionTypes(actions)).toEqual(["stop-poll-interval", "open-event-source"]);
  });

  it("recovers from polling to SSE when the retried connection opens", () => {
    const retrying = transition(POLLING_STATE, { type: "sse-retry-timer-fired" }).state;
    const { state, actions } = transition(retrying, { type: "open" });
    expect(state.phase).toBe("connected");
    // Catch-up sync covers anything missed between the last poll and the open
    expect(actionTypes(actions)).toContain("sync");
  });

  it("falls back to polling again if the retried connection fails with 503", () => {
    const state = run(
      [
        { type: "sse-retry-timer-fired" },
        { type: "stream-error", closed: true },
        { type: "probe-result", sseUnavailable: true },
      ],
      POLLING_STATE
    );
    expect(state.phase).toBe("polling");
  });

  it("ignores a stale probe result after a manual reconnect superseded the probe", () => {
    const reconnecting = transition(PROBING_STATE, { type: "manual-reconnect" }).state;
    const result = transition(reconnecting, { type: "probe-result", sseUnavailable: true });
    expect(result.state).toBe(reconnecting);
    expect(result.actions).toEqual([]);
  });
});

describe("visibility changes", () => {
  it("does nothing when already connected", () => {
    const result = transition(CONNECTED_STATE, { type: "visibility-visible" });
    expect(result.state).toBe(CONNECTED_STATE);
    expect(result.actions).toEqual([]);
  });

  it("does nothing when disconnected (not authenticated)", () => {
    const result = transition(INITIAL_CONNECTION_STATE, { type: "visibility-visible" });
    expect(result.state).toBe(INITIAL_CONNECTION_STATE);
    expect(result.actions).toEqual([]);
  });

  it("syncs immediately while staying in polling mode", () => {
    const result = transition(POLLING_STATE, { type: "visibility-visible" });
    expect(result.state).toBe(POLLING_STATE);
    expect(result.actions).toEqual([{ type: "sync" }]);
  });

  it("reconnects immediately with a fresh backoff while waiting in backoff", () => {
    const backedOff = { ...BACKOFF_STATE, reconnectDelayMs: 16_000 };
    const { state, actions } = transition(backedOff, { type: "visibility-visible" });
    expect(state).toEqual({ phase: "connecting", reconnectDelayMs: INITIAL_RECONNECT_DELAY_MS });
    expect(actionTypes(actions)).toEqual([
      "close-event-source",
      "cancel-reconnect",
      "cancel-sse-retry",
      "stop-poll-interval",
      "open-event-source",
    ]);
  });

  it("restarts a stuck connecting attempt", () => {
    const connecting = run([{ type: "connect" }]);
    const { state, actions } = transition(connecting, { type: "visibility-visible" });
    expect(state.phase).toBe("connecting");
    expect(actionTypes(actions)).toContain("open-event-source");
  });
});

describe("disconnect", () => {
  it("tears everything down from any active phase", () => {
    for (const from of [CONNECTED_STATE, PROBING_STATE, BACKOFF_STATE, POLLING_STATE]) {
      const { state, actions } = transition(from, { type: "disconnect" });
      expect(state.phase).toBe("disconnected");
      expect(actionTypes(actions)).toEqual([
        "close-event-source",
        "cancel-reconnect",
        "cancel-sse-retry",
        "stop-poll-interval",
      ]);
    }
  });

  it("is a no-op when already disconnected", () => {
    const result = transition(INITIAL_CONNECTION_STATE, { type: "disconnect" });
    expect(result.state).toBe(INITIAL_CONNECTION_STATE);
    expect(result.actions).toEqual([]);
  });

  it("ignores manual reconnect while disconnected", () => {
    const result = transition(INITIAL_CONNECTION_STATE, { type: "manual-reconnect" });
    expect(result.state).toBe(INITIAL_CONNECTION_STATE);
    expect(result.actions).toEqual([]);
  });

  it("ignores stale timer events after disconnect", () => {
    const disconnected = transition(POLLING_STATE, { type: "disconnect" }).state;
    for (const event of [
      { type: "reconnect-timer-fired" },
      { type: "sse-retry-timer-fired" },
      { type: "open" },
      { type: "probe-result", sseUnavailable: true },
    ] as ConnectionEvent[]) {
      const result = transition(disconnected, event);
      expect(result.state).toBe(disconnected);
      expect(result.actions).toEqual([]);
    }
  });
});

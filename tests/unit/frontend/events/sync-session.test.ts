/**
 * Unit tests for the catch-up sync session behind useRealtimeUpdates.
 *
 * These encode the invariants in "Catch-up sync after (re)connect" in
 * src/FRONTEND_STATE.md: a failed catch-up is retried with backoff, live
 * events don't advance the cursors until the current connection's catch-up has
 * fully succeeded (#1081), and every page of a catch-up sends where it started
 * (#1663) — plus the serialization the scheduler provides (#897).
 */

import { describe, it, expect } from "vitest";
import {
  INITIAL_SYNC_RETRY_DELAY_MS,
  MAX_SYNC_RETRY_DELAY_MS,
  initialSyncSession,
  reduceSyncSession,
  type SyncSessionAction,
  type SyncSessionEvent,
  type SyncSessionState,
} from "@/lib/events/sync-session";
import type { SyncCursors } from "@/lib/events/cursors";
import type { SyncEvent } from "@/lib/events/schemas";

const INITIAL_CURSORS: SyncCursors = {
  entries: "2026-01-01T00:00:00Z",
  entriesAfterId: "00000000-0000-7000-8000-000000000001",
  subscriptions: "2026-01-01T00:00:00Z",
  tags: null,
};

let entryCounter = 0;

/** An entry_state_changed event at `updatedAt` (entry ids sort in creation order). */
function entryEvent(updatedAt: string): SyncEvent {
  entryCounter += 1;
  return {
    type: "entry_state_changed",
    entryId: `00000000-0000-7000-8000-${String(entryCounter).padStart(12, "0")}`,
    read: true,
    starred: false,
    timestamp: updatedAt,
    updatedAt,
    counts: {
      all: { unread: 0 },
      starred: { unread: 0 },
      subscriptions: [],
      tags: [],
    },
  };
}

/** Feeds events through the reducer, as the hook does. */
class Session {
  state: SyncSessionState = initialSyncSession(INITIAL_CURSORS);

  /** Returns the actions the events produced. */
  send(...events: SyncSessionEvent[]): SyncSessionAction[] {
    const produced: SyncSessionAction[] = [];
    for (const event of events) {
      const { state, actions } = reduceSyncSession(this.state, event);
      this.state = state;
      produced.push(...actions);
    }
    return produced;
  }

  /** Opens a connection and requests its catch-up, returning the sync it starts. */
  connect(): Extract<SyncSessionAction, { type: "run-sync" }> {
    const run = runSyncIn(this.send({ type: "connection-opened" }, { type: "sync-requested" }));
    expect(run).toBeDefined();
    return run!;
  }

  succeed(run: { epoch: number }, events: SyncEvent[] = [], hasMore = false): SyncSessionAction[] {
    return this.send({ type: "sync-result", epoch: run.epoch, ok: true, events, hasMore });
  }

  fail(run: { epoch: number }): SyncSessionAction[] {
    return this.send({ type: "sync-result", epoch: run.epoch, ok: false });
  }

  live(event: SyncEvent): void {
    this.send({ type: "live-event", event });
  }
}

function runSyncIn(
  actions: SyncSessionAction[]
): Extract<SyncSessionAction, { type: "run-sync" }> | undefined {
  return actions.find(
    (action): action is Extract<SyncSessionAction, { type: "run-sync" }> =>
      action.type === "run-sync"
  );
}

function retryDelayIn(actions: SyncSessionAction[]): number | undefined {
  const retry = actions.find((action) => action.type === "schedule-retry");
  return retry?.type === "schedule-retry" ? retry.delayMs : undefined;
}

describe("reduceSyncSession: starting syncs", () => {
  it("doesn't sync before a connection opens", () => {
    const session = new Session();
    expect(session.send({ type: "sync-requested" })).toEqual([]);
    expect(session.send({ type: "retry-fired" })).toEqual([]);
  });

  it("starts the catch-up from the current cursors, which are also where it started", () => {
    const run = new Session().connect();
    expect(run.cursors).toEqual({
      entries: INITIAL_CURSORS.entries,
      entriesAfterId: INITIAL_CURSORS.entriesAfterId,
      entriesSince: INITIAL_CURSORS.entries,
      entriesSinceAfterId: INITIAL_CURSORS.entriesAfterId,
      subscriptions: INITIAL_CURSORS.subscriptions,
      tags: undefined,
    });
  });

  it("never runs two syncs at once, coalescing requests into one follow-up", () => {
    const session = new Session();
    const run = session.connect();
    expect(session.send({ type: "sync-requested" }, { type: "sync-requested" })).toEqual([]);

    const followUp = runSyncIn(session.succeed(run));
    expect(followUp).toBeDefined();
    expect(runSyncIn(session.succeed(followUp!))).toBeUndefined();
  });
});

describe("reduceSyncSession: cursor freeze (#1081)", () => {
  it("doesn't advance the cursors from live events before the catch-up succeeds", () => {
    const session = new Session();
    session.connect();
    session.live(entryEvent("2026-01-02T00:00:00Z"));
    expect(session.state.cursors).toEqual(INITIAL_CURSORS);
  });

  it("advances the cursors from live events once the catch-up has drained", () => {
    const session = new Session();
    const run = session.connect();
    session.succeed(run);

    session.live(entryEvent("2026-01-02T00:00:00Z"));
    expect(session.state.cursors.entries).toBe("2026-01-02T00:00:00Z");
  });

  it("always advances the cursors from the catch-up's own events", () => {
    const session = new Session();
    const run = session.connect();
    session.succeed(run, [entryEvent("2026-01-03T00:00:00Z")], true);
    expect(session.state.cursors.entries).toBe("2026-01-03T00:00:00Z");
    expect(session.state.caughtUp).toBe(false);
  });

  it("stays frozen while the catch-up still has more pages", () => {
    const session = new Session();
    const run = session.connect();
    const next = runSyncIn(session.succeed(run, [], true));
    expect(next).toBeDefined();
    expect(session.state.caughtUp).toBe(false);

    session.succeed(next!);
    expect(session.state.caughtUp).toBe(true);
  });

  it("stays frozen when a follow-up was requested during the catch-up", () => {
    const session = new Session();
    const run = session.connect();
    session.send({ type: "sync-requested" });
    const followUp = runSyncIn(session.succeed(run));
    expect(session.state.caughtUp).toBe(false);

    session.succeed(followUp!);
    expect(session.state.caughtUp).toBe(true);
  });

  it("stays frozen when the catch-up fails", () => {
    const session = new Session();
    const run = session.connect();
    session.fail(run);
    session.live(entryEvent("2026-01-02T00:00:00Z"));
    expect(session.state.cursors).toEqual(INITIAL_CURSORS);
  });

  it("refreezes on a stream error", () => {
    const session = new Session();
    session.succeed(session.connect());

    session.send({ type: "stream-error" });
    session.live(entryEvent("2026-01-02T00:00:00Z"));
    expect(session.state.cursors).toEqual(INITIAL_CURSORS);
  });

  it("doesn't let a late success from before a stream error unfreeze", () => {
    const session = new Session();
    const run = session.connect();
    // The browser's silent auto-reconnect: an error, and no new catch-up yet.
    session.send({ type: "stream-error" });
    session.succeed(run);

    expect(session.state.caughtUp).toBe(false);
    session.live(entryEvent("2026-01-02T00:00:00Z"));
    expect(session.state.cursors).toEqual(INITIAL_CURSORS);
  });

  it("doesn't let a superseded connection's late success unfreeze the new one", () => {
    const session = new Session();
    const old = session.connect();
    session.send({ type: "stream-error" }, { type: "connection-opened" });
    session.succeed(old);
    expect(session.state.caughtUp).toBe(false);

    // The new connection's own catch-up does.
    const current = runSyncIn(session.send({ type: "sync-requested" }));
    session.succeed(current!);
    expect(session.state.caughtUp).toBe(true);
  });
});

describe("reduceSyncSession: the catch-up's start (#1663)", () => {
  it("sends where the catch-up started with every page", () => {
    const session = new Session();
    const first = session.connect();
    const second = runSyncIn(session.succeed(first, [entryEvent("2026-01-03T00:00:00Z")], true));

    expect(second?.cursors.entries).toBe("2026-01-03T00:00:00Z");
    expect(second?.cursors.entriesSince).toBe(INITIAL_CURSORS.entries);
    expect(second?.cursors.entriesSinceAfterId).toBe(INITIAL_CURSORS.entriesAfterId);
  });

  it("holds the start through failures and reconnects", () => {
    const session = new Session();
    const first = session.connect();
    const second = runSyncIn(session.succeed(first, [entryEvent("2026-01-03T00:00:00Z")], true));
    session.fail(second!);

    session.send({ type: "stream-error" }, { type: "disconnected" });
    const afterReconnect = session.connect();
    expect(afterReconnect.cursors.entries).toBe("2026-01-03T00:00:00Z");
    expect(afterReconnect.cursors.entriesSince).toBe(INITIAL_CURSORS.entries);
  });

  it("starts the next catch-up from the cursors once one reports no more", () => {
    const session = new Session();
    const first = session.connect();
    session.succeed(first, [entryEvent("2026-01-03T00:00:00Z")]);

    session.send({ type: "stream-error" });
    const next = runSyncIn(session.send({ type: "connection-opened" }, { type: "sync-requested" }));
    expect(next?.cursors.entriesSince).toBe("2026-01-03T00:00:00Z");
  });
});

describe("reduceSyncSession: retries", () => {
  it("retries a failed catch-up with exponential backoff, capped", () => {
    const session = new Session();
    let run = session.connect();
    const delays: number[] = [];
    for (let i = 0; i < 6; i++) {
      delays.push(retryDelayIn(session.fail(run))!);
      run = runSyncIn(session.send({ type: "retry-fired" }))!;
    }
    expect(delays).toEqual([2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);
    expect(delays[0]).toBe(INITIAL_SYNC_RETRY_DELAY_MS);
    expect(delays.at(-1)).toBe(MAX_SYNC_RETRY_DELAY_MS);
  });

  it("re-queries the same gap on retry", () => {
    const session = new Session();
    const run = session.connect();
    session.fail(run);
    const retry = runSyncIn(session.send({ type: "retry-fired" }));
    expect(retry?.cursors).toEqual(run.cursors);
  });

  it("cancels a pending retry and resets the backoff on success", () => {
    const session = new Session();
    let run = session.connect();
    session.fail(run);
    run = runSyncIn(session.send({ type: "retry-fired" }))!;
    session.fail(run);
    run = runSyncIn(session.send({ type: "sync-requested" }))!;

    expect(session.succeed(run)).toContainEqual({ type: "cancel-retry" });
    run = runSyncIn(session.send({ type: "sync-requested" }))!;
    expect(retryDelayIn(session.fail(run))).toBe(INITIAL_SYNC_RETRY_DELAY_MS);
  });

  it("runs a follow-up requested during a failed sync without waiting for the retry", () => {
    const session = new Session();
    const run = session.connect();
    session.send({ type: "sync-requested" });
    const actions = session.fail(run);
    expect(retryDelayIn(actions)).toBe(INITIAL_SYNC_RETRY_DELAY_MS);
    expect(runSyncIn(actions)).toBeDefined();
  });

  it("coalesces a retry that fires while another sync runs", () => {
    const session = new Session();
    const run = session.connect();
    session.fail(run);
    const running = runSyncIn(session.send({ type: "sync-requested" }))!;
    expect(session.send({ type: "retry-fired" })).toEqual([]);
    expect(runSyncIn(session.succeed(running))).toBeDefined();
  });
});

describe("reduceSyncSession: disconnecting", () => {
  it("cancels a pending retry and resets the backoff", () => {
    const session = new Session();
    let run = session.connect();
    session.fail(run);
    run = runSyncIn(session.send({ type: "retry-fired" }))!;
    session.fail(run);

    expect(session.send({ type: "disconnected" })).toEqual([{ type: "cancel-retry" }]);
    expect(session.send({ type: "retry-fired" }, { type: "sync-requested" })).toEqual([]);

    const afterReconnect = session.connect();
    expect(retryDelayIn(session.fail(afterReconnect))).toBe(INITIAL_SYNC_RETRY_DELAY_MS);
  });

  it("settles a sync still in flight without a follow-up or retry", () => {
    const session = new Session();
    const run = session.connect();
    session.send({ type: "sync-requested" }, { type: "disconnected" });

    expect(runSyncIn(session.succeed(run, [], true))).toBeUndefined();
    expect(session.state.scheduler).toEqual({ running: false, pending: false });

    const failing = session.connect();
    session.send({ type: "disconnected" });
    expect(retryDelayIn(session.fail(failing))).toBeUndefined();
  });

  it("keeps applying an in-flight sync's events after disconnecting", () => {
    const session = new Session();
    const run = session.connect();
    session.send({ type: "disconnected" });
    session.succeed(run, [entryEvent("2026-01-03T00:00:00Z")]);
    expect(session.state.cursors.entries).toBe("2026-01-03T00:00:00Z");
  });

  it("serializes a quick reconnect's catch-up behind the old connection's sync", () => {
    const session = new Session();
    const old = session.connect();
    session.send({ type: "disconnected" });

    expect(session.send({ type: "connection-opened" }, { type: "sync-requested" })).toEqual([]);
    const current = runSyncIn(session.succeed(old));
    expect(current).toBeDefined();
    expect(session.state.caughtUp).toBe(false);

    session.succeed(current!);
    expect(session.state.caughtUp).toBe(true);
  });
});

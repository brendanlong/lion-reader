/**
 * Unit tests for the sync serialization scheduler.
 *
 * These encode the #897 invariant: two catch-up syncs must never run
 * concurrently (they would read the same cursors and double-apply delta-based
 * cache updates), yet a request that arrives mid-sync must not be dropped — it
 * has to run once the in-flight sync settles.
 */

import { describe, it, expect } from "vitest";
import {
  INITIAL_SYNC_SCHEDULER_STATE,
  reduceSyncScheduler,
  type SyncSchedulerEvent,
  type SyncSchedulerState,
} from "@/lib/events/sync-scheduler";

/**
 * Drives the scheduler the way the async hook glue does: starting a sync only
 * *kicks off* an in-flight run (it does not settle inline), so a burst of
 * synchronous requests lands while a sync is genuinely running — the real #897
 * race. Completions are deferred and drained afterward, and each may start a
 * follow-up. Returns how many syncs actually ran so tests can assert
 * serialization directly; the harness also asserts no sync ever starts while
 * another is running.
 */
function runScenario(
  requests: number,
  hasMoreSequence: boolean[] = [],
  from: SyncSchedulerState = INITIAL_SYNC_SCHEDULER_STATE
): { state: SyncSchedulerState; syncsRun: number } {
  let state = from;
  let running = false;
  let syncsRun = 0;
  let hasMoreIndex = 0;
  const pendingCompletions: Array<() => void> = [];

  const dispatch = (event: SyncSchedulerEvent): void => {
    const result = reduceSyncScheduler(state, event);
    state = result.state;
    if (result.startSync) {
      // The scheduler must never ask us to start a sync while one is running.
      expect(running).toBe(false);
      running = true;
      syncsRun += 1;
      // Defer the completion: the sync is now "in flight" until drained.
      pendingCompletions.push(() => {
        running = false;
        const hasMore = hasMoreSequence[hasMoreIndex++] ?? false;
        dispatch({ type: "completed", hasMore });
      });
    }
  };

  // Burst of synchronous requests, all landing while the first sync is in flight.
  for (let i = 0; i < requests; i++) {
    dispatch({ type: "request" });
  }

  // Settle in-flight syncs one at a time; each may kick off a follow-up.
  while (pendingCompletions.length > 0) {
    pendingCompletions.shift()!();
  }

  return { state, syncsRun };
}

describe("reduceSyncScheduler", () => {
  it("starts a sync when idle", () => {
    const result = reduceSyncScheduler(INITIAL_SYNC_SCHEDULER_STATE, { type: "request" });
    expect(result.startSync).toBe(true);
    expect(result.state).toEqual({ running: true, pending: false });
  });

  it("does not start a second sync while one is running, but marks it pending", () => {
    const running: SyncSchedulerState = { running: true, pending: false };
    const result = reduceSyncScheduler(running, { type: "request" });
    expect(result.startSync).toBe(false);
    expect(result.state).toEqual({ running: true, pending: true });
  });

  it("collapses multiple overlapping requests into a single pending follow-up", () => {
    let state: SyncSchedulerState = { running: true, pending: false };
    for (let i = 0; i < 5; i++) {
      state = reduceSyncScheduler(state, { type: "request" }).state;
    }
    expect(state).toEqual({ running: true, pending: true });
  });

  it("returns to idle when a sync completes with nothing queued", () => {
    const running: SyncSchedulerState = { running: true, pending: false };
    const result = reduceSyncScheduler(running, { type: "completed", hasMore: false });
    expect(result.startSync).toBe(false);
    expect(result.state).toEqual({ running: false, pending: false });
  });

  it("starts the queued follow-up when a sync completes with a request pending", () => {
    const pending: SyncSchedulerState = { running: true, pending: true };
    const result = reduceSyncScheduler(pending, { type: "completed", hasMore: false });
    expect(result.startSync).toBe(true);
    expect(result.state).toEqual({ running: true, pending: false });
  });

  it("continues draining when the server still hasMore, even with nothing queued", () => {
    const running: SyncSchedulerState = { running: true, pending: false };
    const result = reduceSyncScheduler(running, { type: "completed", hasMore: true });
    expect(result.startSync).toBe(true);
    expect(result.state).toEqual({ running: true, pending: false });
  });

  it("ignores a completion when no sync is running", () => {
    const result = reduceSyncScheduler(INITIAL_SYNC_SCHEDULER_STATE, {
      type: "completed",
      hasMore: false,
    });
    expect(result.startSync).toBe(false);
    expect(result.state).toBe(INITIAL_SYNC_SCHEDULER_STATE);
  });
});

describe("reduceSyncScheduler serialization (driven scenarios)", () => {
  it("runs a single sync for a single request", () => {
    const { state, syncsRun } = runScenario(1);
    expect(syncsRun).toBe(1);
    expect(state).toEqual(INITIAL_SYNC_SCHEDULER_STATE);
  });

  it("never runs two syncs concurrently and ends idle", () => {
    // runScenario asserts running===false on every start, so reaching here
    // without throwing proves serialization held.
    const { state, syncsRun } = runScenario(10);
    expect(syncsRun).toBeGreaterThan(0);
    expect(state).toEqual(INITIAL_SYNC_SCHEDULER_STATE);
  });

  it("coalesces a burst of synchronous requests into at most two runs", () => {
    // The first request runs immediately; the rest collapse into one follow-up.
    const { syncsRun } = runScenario(4);
    expect(syncsRun).toBe(2);
  });

  it("drains all pages when the server reports hasMore", () => {
    // One request, but the server returns hasMore twice before draining.
    const { state, syncsRun } = runScenario(1, [true, true, false]);
    expect(syncsRun).toBe(3);
    expect(state).toEqual(INITIAL_SYNC_SCHEDULER_STATE);
  });
});

/**
 * Catch-up Sync Session
 *
 * Pure decision logic for the sync side of `useRealtimeUpdates`: the sync
 * cursors, the catch-up sync after each (re)connect, its backoff retry, and
 * the cursor freeze that keeps live events from skipping a not-yet-synced gap.
 * `reduceSyncSession(state, event)` returns the next state plus the actions
 * for the hook to execute (run a `sync.events` query, set or clear the retry
 * timer), in the style of `connection-state.ts`. The invariants it upholds
 * are described under "Catch-up sync after (re)connect" in
 * `src/FRONTEND_STATE.md`.
 *
 * Syncs are serialized by `reduceSyncScheduler` (#897): at most one runs at a
 * time, and requests made meanwhile coalesce into one follow-up.
 */

import { advanceCursors, type SyncCursors } from "./cursors";
import type { SyncEvent } from "./schemas";
import {
  INITIAL_SYNC_SCHEDULER_STATE,
  reduceSyncScheduler,
  type SyncSchedulerState,
} from "./sync-scheduler";

/**
 * Backoff bounds for retrying a failed catch-up sync. Without the retry, a
 * catch-up that fails on SSE `open` is never retried, so changes from other
 * devices in the disconnected window stay wrong on an idle view (#1081).
 */
export const INITIAL_SYNC_RETRY_DELAY_MS = 2_000;
export const MAX_SYNC_RETRY_DELAY_MS = 30_000;

export interface SyncSessionState {
  /**
   * Whether a connection is wanted (between an EventSource opening and the
   * hook disconnecting). Syncs start and retry only while it is.
   */
  active: boolean;
  cursors: SyncCursors;
  /**
   * Where the current multi-page catch-up started; sent unchanged with each of
   * its pages so the server reports changes an entry had before a later page's
   * cursor (#1663). Null between catch-ups. Kept through failures and
   * reconnects: an older start only re-reports changes, a newer one loses them.
   */
  catchUpStart: SyncCursors | null;
  /**
   * Whether the current connection's catch-up has fully succeeded. Until it
   * has, live events patch the cache but don't advance the cursors, which would
   * push them past the gap the pending (or retrying) catch-up still has to
   * fetch (#1081). Catch-up results always advance them.
   */
  caughtUp: boolean;
  /**
   * Bumped at every freeze (a new connection or a stream error). A catch-up
   * may only mark caught-up if no freeze happened while it ran, or a sync
   * from a superseded connection could unfreeze past the current one's gap.
   */
  epoch: number;
  scheduler: SyncSchedulerState;
  /** The delay before the next retry of a failing catch-up. */
  retryDelayMs: number;
}

/** The cursors a `sync.events` request sends. */
export interface SyncQueryCursors {
  entries?: string;
  entriesAfterId?: string;
  entriesSince?: string;
  entriesSinceAfterId?: string;
  subscriptions?: string;
  tags?: string;
}

export type SyncSessionEvent =
  /** A new EventSource was opened. */
  | { type: "connection-opened" }
  /** The EventSource errored (including the browser's silent auto-reconnect). */
  | { type: "stream-error" }
  /** The hook disconnected (logged out or unmounted). */
  | { type: "disconnected" }
  /** A live SSE event arrived. */
  | { type: "live-event"; event: SyncEvent }
  /** Something wants a sync: a connection opening, a poll tick, the tab becoming visible. */
  | { type: "sync-requested" }
  /** The retry timer fired. */
  | { type: "retry-fired" }
  /** A sync started by `run-sync` settled. */
  | { type: "sync-result"; epoch: number; ok: true; events: SyncEvent[]; hasMore: boolean }
  | { type: "sync-result"; epoch: number; ok: false };

export type SyncSessionAction =
  | { type: "run-sync"; epoch: number; cursors: SyncQueryCursors }
  | { type: "schedule-retry"; delayMs: number }
  | { type: "cancel-retry" };

export interface SyncSessionResult {
  state: SyncSessionState;
  actions: SyncSessionAction[];
}

export function initialSyncSession(cursors: SyncCursors): SyncSessionState {
  return {
    active: false,
    cursors,
    catchUpStart: null,
    caughtUp: false,
    epoch: 0,
    scheduler: INITIAL_SYNC_SCHEDULER_STATE,
    retryDelayMs: INITIAL_SYNC_RETRY_DELAY_MS,
  };
}

function freeze(state: SyncSessionState): SyncSessionState {
  return { ...state, caughtUp: false, epoch: state.epoch + 1 };
}

/** Starts a sync from the current cursors, holding the catch-up's start. */
function startSync(state: SyncSessionState): SyncSessionResult {
  const start = state.catchUpStart ?? state.cursors;
  const { cursors } = state;
  return {
    state: { ...state, catchUpStart: start },
    actions: [
      {
        type: "run-sync",
        epoch: state.epoch,
        cursors: {
          entries: cursors.entries ?? undefined,
          entriesAfterId: cursors.entriesAfterId ?? undefined,
          entriesSince: start.entries ?? undefined,
          entriesSinceAfterId: start.entriesAfterId ?? undefined,
          subscriptions: cursors.subscriptions ?? undefined,
          tags: cursors.tags ?? undefined,
        },
      },
    ],
  };
}

function requestSync(state: SyncSessionState): SyncSessionResult {
  if (!state.active) return { state, actions: [] };
  const scheduled = reduceSyncScheduler(state.scheduler, { type: "request" });
  const next = { ...state, scheduler: scheduled.state };
  return scheduled.startSync ? startSync(next) : { state: next, actions: [] };
}

function settleSync(
  state: SyncSessionState,
  event: Extract<SyncSessionEvent, { type: "sync-result" }>
): SyncSessionResult {
  let next = state;
  const actions: SyncSessionAction[] = [];

  if (event.ok) {
    // The catch-up drains the authoritative server sequence, so its events
    // always advance the cursors.
    const cursors = event.events.reduce(advanceCursors, state.cursors);
    // Caught up only when this sync drained everything, no follow-up was
    // requested meanwhile, and no freeze happened since it started.
    const caughtUp =
      state.caughtUp || (!event.hasMore && !state.scheduler.pending && event.epoch === state.epoch);
    next = {
      ...state,
      cursors,
      catchUpStart: event.hasMore ? state.catchUpStart : null,
      caughtUp,
      retryDelayMs: INITIAL_SYNC_RETRY_DELAY_MS,
    };
    actions.push({ type: "cancel-retry" });
  } else if (state.active) {
    // The cursors stay frozen, so the retry re-queries the same gap.
    next = {
      ...state,
      retryDelayMs: Math.min(state.retryDelayMs * 2, MAX_SYNC_RETRY_DELAY_MS),
    };
    actions.push({ type: "schedule-retry", delayMs: state.retryDelayMs });
  }

  // Disconnected while it ran: settle without a follow-up.
  if (!next.active) {
    return { state: { ...next, scheduler: INITIAL_SYNC_SCHEDULER_STATE }, actions };
  }

  // A failure settles as "no more": the retry timer drives what comes next.
  const scheduled = reduceSyncScheduler(next.scheduler, {
    type: "completed",
    hasMore: event.ok && event.hasMore,
  });
  next = { ...next, scheduler: scheduled.state };
  if (!scheduled.startSync) return { state: next, actions };
  const started = startSync(next);
  return { state: started.state, actions: [...actions, ...started.actions] };
}

export function reduceSyncSession(
  state: SyncSessionState,
  event: SyncSessionEvent
): SyncSessionResult {
  switch (event.type) {
    case "connection-opened":
      return { state: { ...freeze(state), active: true }, actions: [] };

    case "stream-error":
      return { state: freeze(state), actions: [] };

    case "disconnected":
      // The scheduler is left as is: a sync still in flight settles it, so
      // one started after a quick reconnect waits for it rather than racing it.
      return {
        state: { ...state, active: false, retryDelayMs: INITIAL_SYNC_RETRY_DELAY_MS },
        actions: [{ type: "cancel-retry" }],
      };

    case "live-event": {
      if (!state.caughtUp) return { state, actions: [] };
      const cursors = advanceCursors(state.cursors, event.event);
      return { state: cursors === state.cursors ? state : { ...state, cursors }, actions: [] };
    }

    case "sync-requested":
    case "retry-fired":
      return requestSync(state);

    case "sync-result":
      return settleSync(state, event);
  }
}

/**
 * Sync Serialization Scheduler
 *
 * Pure decision logic that serializes catch-up syncs so two of them never run
 * concurrently. Without this, overlapping syncs (a poll tick firing while a
 * slow sync is still awaiting `sync.events`, a visibility-triggered sync over an
 * in-flight poll, or the `hasMore` continuation racing a poll) read the same
 * cursors and process the same events twice. Idempotent handlers shrug that off,
 * but delta-based handlers (`new_entry` incrementing unread counts) double-apply,
 * inflating counts until the next absolute-count event corrects them. See #897.
 *
 * A naive "skip if already syncing" lock isn't enough: a request that arrives
 * while a sync is running (e.g. the catch-up sync triggered on SSE `open`) must
 * still run *after* the in-flight sync finishes, or events between the two
 * cursor reads are missed until the next poll/reconnect. So instead of dropping
 * overlapping requests we coalesce them into a single follow-up run.
 *
 * `reduceSyncScheduler(state, event)` returns the next state plus whether the
 * caller should start a sync now. Keeping it pure makes the serialization
 * behavior unit-testable without timers or network mocks, the same way the
 * connection state machine in `connection-state.ts` is.
 */

export interface SyncSchedulerState {
  /** A sync is currently in flight. */
  running: boolean;
  /**
   * A sync was requested while one was already running, so another should run
   * once the in-flight one settles. Multiple overlapping requests collapse into
   * this single flag (one follow-up, not one per request).
   */
  pending: boolean;
}

export const INITIAL_SYNC_SCHEDULER_STATE: SyncSchedulerState = {
  running: false,
  pending: false,
};

export type SyncSchedulerEvent =
  /** Something wants a sync (poll tick, visibility, catch-up on connect). */
  | { type: "request" }
  /**
   * The in-flight sync settled. `hasMore` is true when the server reported more
   * events than the page returned, so the drain must continue with another run.
   */
  | { type: "completed"; hasMore: boolean };

export interface SyncSchedulerResult {
  state: SyncSchedulerState;
  /** When true, the caller should begin executing one sync now. */
  startSync: boolean;
}

/**
 * Computes the next scheduler state and whether to start a sync.
 *
 * - `request` while idle starts a sync immediately.
 * - `request` while running sets `pending` so exactly one follow-up runs later.
 * - `completed` starts another sync when a request was queued (`pending`) or the
 *   server still `hasMore`; otherwise it returns to idle.
 *
 * A `completed` event with no sync running is ignored (returns the same state),
 * since there is nothing to settle.
 */
export function reduceSyncScheduler(
  state: SyncSchedulerState,
  event: SyncSchedulerEvent
): SyncSchedulerResult {
  switch (event.type) {
    case "request":
      if (state.running) {
        return { state: { running: true, pending: true }, startSync: false };
      }
      return { state: { running: true, pending: false }, startSync: true };

    case "completed":
      if (!state.running) {
        return { state, startSync: false };
      }
      if (state.pending || event.hasMore) {
        return { state: { running: true, pending: false }, startSync: true };
      }
      return { state: { running: false, pending: false }, startSync: false };
  }
}

/**
 * Entry Mutation Tracker
 *
 * Pure bookkeeping for the "optimistic write + timestamp reconciliation"
 * pattern in src/FRONTEND_STATE.md ("Optimistic Updates"): holds the newest
 * server response (by `updatedAt`) for an entry until every in-flight
 * mutation for it has settled, then hands back one state to write. No React,
 * no cache access — the hook owns the cache writes. One tracker is shared per
 * QueryClient (`getEntryMutationTracker`).
 *
 * Contract: every `start` must be matched by exactly one `settle`.
 * `recordSuccess`/`settle` on an untracked entry is a programming error and
 * throws rather than degrading to unguarded last-write-wins.
 */

import type { QueryClient } from "@tanstack/react-query";

export interface EntryState {
  read: boolean;
  starred: boolean;
}

export interface EntryServerState extends EntryState {
  /** The server's `updatedAt` for the entry after this mutation. */
  updatedAt: Date;
}

export type EntryField = keyof EntryState;

export type EntrySettlement =
  /** Every in-flight mutation settled and at least one succeeded. */
  | { kind: "apply"; state: EntryServerState }
  /**
   * Every in-flight mutation failed; `state` holds the pre-mutation value of
   * each field one of them wrote (undefined when the entry was in no cache).
   * Fields none of them wrote are left alone, so a concurrent SSE change to
   * the other field survives the rollback.
   */
  | { kind: "rollback"; state: Partial<EntryState> | undefined };

interface Tracking {
  pendingCount: number;
  winner: EntryServerState | null;
  original: EntryState | undefined;
  written: Set<EntryField>;
}

export class EntryMutationTracker {
  private readonly entries = new Map<string, Tracking>();

  /**
   * Registers an in-flight mutation that optimistically writes `field`.
   * `original` is only used when this is the first pending mutation — later
   * ones inherit the snapshot taken before any of them changed the cache.
   */
  start(entryId: string, field: EntryField, original: EntryState | undefined): void {
    const tracking = this.entries.get(entryId);
    if (tracking) {
      tracking.pendingCount++;
      tracking.written.add(field);
    } else {
      this.entries.set(entryId, {
        pendingCount: 1,
        winner: null,
        original,
        written: new Set([field]),
      });
    }
  }

  /** Records a successful response; the newest `updatedAt` wins. */
  recordSuccess(entryId: string, state: EntryServerState): void {
    const tracking = this.getTracked(entryId);
    if (!tracking.winner || state.updatedAt.getTime() >= tracking.winner.updatedAt.getTime()) {
      tracking.winner = state;
    }
  }

  /**
   * Marks one mutation for the entry as finished. Returns the state to write
   * once no mutations remain in flight, or null while others are pending.
   */
  settle(entryId: string): EntrySettlement | null {
    const tracking = this.getTracked(entryId);
    tracking.pendingCount--;
    if (tracking.pendingCount > 0) return null;

    this.entries.delete(entryId);
    if (tracking.winner) {
      return { kind: "apply", state: tracking.winner };
    }
    if (!tracking.original) {
      return { kind: "rollback", state: undefined };
    }
    const state: Partial<EntryState> = {};
    for (const field of tracking.written) {
      state[field] = tracking.original[field];
    }
    return { kind: "rollback", state };
  }

  hasPending(entryId: string): boolean {
    return this.entries.has(entryId);
  }

  private getTracked(entryId: string): Tracking {
    const tracking = this.entries.get(entryId);
    if (!tracking) {
      throw new Error(`No in-flight mutation tracked for entry ${entryId}`);
    }
    return tracking;
  }
}

const trackers = new WeakMap<QueryClient, EntryMutationTracker>();

export function getEntryMutationTracker(queryClient: QueryClient): EntryMutationTracker {
  let tracker = trackers.get(queryClient);
  if (!tracker) {
    tracker = new EntryMutationTracker();
    trackers.set(queryClient, tracker);
  }
  return tracker;
}

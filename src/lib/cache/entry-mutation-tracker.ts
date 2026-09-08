/**
 * Entry Mutation Tracker
 *
 * Reconciles concurrent read/starred mutations for the same entry. Entry
 * mutations are optimistic but never cancel in-flight queries (cancelling
 * `entries.get` aborts content fetches), so their responses can complete out
 * of order and race with each other. The tracker holds the newest response
 * (by server `updatedAt`) until every in-flight mutation for the entry has
 * settled, and only then hands back one state to write — the optimistic state
 * stays on screen in the meantime instead of flickering through each
 * intermediate server response.
 *
 * Pure bookkeeping: no React, no cache access. The hook owns the cache writes.
 * One tracker is shared per QueryClient (`getEntryMutationTracker`) so
 * mutations issued from different components (the reader's auto-mark-read and
 * the list's keyboard toggle, say) reconcile against each other.
 *
 * Contract: every `start` must be matched by exactly one `settle`, from the
 * mutation's `onSettled` (which React Query runs once per mutation, success or
 * failure). `recordSuccess`/`settle` on an untracked entry is a programming
 * error and throws rather than degrading to unguarded last-write-wins.
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

export type EntrySettlement =
  /** Every in-flight mutation settled and at least one succeeded. */
  | { kind: "apply"; state: EntryServerState }
  /**
   * Every in-flight mutation failed; `state` is the cached state before the
   * first one started (undefined when the entry was in no cache).
   */
  | { kind: "rollback"; state: EntryState | undefined };

interface Tracking {
  pendingCount: number;
  winner: EntryServerState | null;
  original: EntryState | undefined;
}

export class EntryMutationTracker {
  private readonly entries = new Map<string, Tracking>();

  /**
   * Registers an in-flight mutation for the entry. `original` is only used
   * when this is the first pending mutation — later ones inherit the snapshot
   * taken before any of them changed the cache.
   */
  start(entryId: string, original: EntryState | undefined): void {
    const tracking = this.entries.get(entryId);
    if (tracking) {
      tracking.pendingCount++;
    } else {
      this.entries.set(entryId, { pendingCount: 1, winner: null, original });
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
    return tracking.winner
      ? { kind: "apply", state: tracking.winner }
      : { kind: "rollback", state: tracking.original };
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

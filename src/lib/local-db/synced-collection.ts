/**
 * A TanStack DB collection whose synced layer we write directly from server
 * data (query results, mutation responses, SSE events), with user mutations
 * layered on top as optimistic transactions.
 *
 * Writes use `begin({ immediate: true })` so server data lands even while an
 * optimistic transaction for the same row is in flight — the overlay keeps
 * showing the user's intent, and when the transaction settles (or fails) the
 * row falls back to the newest server state rather than a stale snapshot.
 *
 * With a mirror attached (see `persistence.ts`), every synced write is also
 * copied to it, so the synced layer survives reloads.
 */

import { createCollection, type Collection, type SyncConfig } from "@tanstack/db";

type SyncParams<T extends object> = Parameters<SyncConfig<T, string>["sync"]>[0];

/** Where synced writes are copied to. Writes are fire-and-forget. */
export interface SyncedMirror<T> {
  put: (rows: T[]) => void;
  delete: (keys: string[]) => void;
}

export interface SyncedCollection<T extends object> {
  collection: Collection<T, string>;
  /** The last server value written for `key` (never the optimistic view). */
  getSynced: (key: string) => T | undefined;
  /** Every synced row. */
  syncedRows: () => IterableIterator<T>;
  /** Inserts or replaces rows in the synced layer, in one transaction. */
  upsert: (rows: T[]) => void;
  remove: (keys: string[]) => void;
  /** Copies every later write to `mirror`. */
  setMirror: (mirror: SyncedMirror<T>) => void;
}

export function createSyncedCollection<T extends object>(options: {
  id: string;
  getKey: (row: T) => string;
}): SyncedCollection<T> {
  const synced = new Map<string, T>();
  let params: SyncParams<T> | null = null;
  let mirror: SyncedMirror<T> | null = null;

  const collection = createCollection<T, string>({
    id: options.id,
    getKey: options.getKey,
    startSync: true,
    // Never garbage-collect: these are long-lived normalized stores that
    // outlive any one component's subscription.
    gcTime: 0,
    sync: {
      sync: (syncParams) => {
        params = syncParams;
        syncParams.markReady();
      },
    },
  });

  const getParams = (): SyncParams<T> => {
    if (!params) throw new Error(`Collection ${options.id} has not started syncing`);
    return params;
  };

  return {
    collection,
    getSynced: (key) => synced.get(key),
    syncedRows: () => synced.values(),
    upsert: (rows) => {
      if (rows.length === 0) return;
      const { begin, write, commit } = getParams();
      begin({ immediate: true });
      for (const row of rows) {
        const key = options.getKey(row);
        write({ type: synced.has(key) ? "update" : "insert", value: row });
        synced.set(key, row);
      }
      commit();
      mirror?.put(rows);
    },
    remove: (keys) => {
      const present = keys.filter((key) => synced.has(key));
      if (present.length === 0) return;
      const { begin, write, commit } = getParams();
      begin({ immediate: true });
      for (const key of present) {
        write({ type: "delete", key });
        synced.delete(key);
      }
      commit();
      mirror?.delete(present);
    },
    setMirror: (next) => {
      mirror = next;
    },
  };
}

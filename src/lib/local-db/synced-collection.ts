/**
 * A TanStack DB collection whose synced layer we write directly from server
 * data (query results, mutation responses, SSE events), with user mutations
 * layered on top as optimistic transactions.
 *
 * Writes use `begin({ immediate: true })` so server data lands even while an
 * optimistic transaction for the same row is in flight — the overlay keeps
 * showing the user's intent, and when the transaction settles (or fails) the
 * row falls back to the newest server state rather than a stale snapshot.
 */

import { createCollection, type Collection, type SyncConfig } from "@tanstack/db";

type SyncParams<T extends object> = Parameters<SyncConfig<T, string>["sync"]>[0];

export interface SyncedCollection<T extends object> {
  collection: Collection<T, string>;
  /** The last server value written for `key` (never the optimistic view). */
  getSynced: (key: string) => T | undefined;
  /** Inserts or replaces rows in the synced layer, in one transaction. */
  upsert: (rows: T[]) => void;
  remove: (keys: string[]) => void;
}

export function createSyncedCollection<T extends object>(options: {
  id: string;
  getKey: (row: T) => string;
}): SyncedCollection<T> {
  const synced = new Map<string, T>();
  let params: SyncParams<T> | null = null;

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
    },
  };
}

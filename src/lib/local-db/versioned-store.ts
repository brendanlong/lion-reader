/**
 * Rows the client writes both from fetches and live (events, mutation
 * responses), ordered by a local clock: a live write by when it happened, a
 * fetched row by when its fetch started. A fetched row is stored only over an
 * older version, so a fetch that started before a newer write (or a removal)
 * can't undo it when it lands.
 */

import type { SyncedCollection } from "./synced-collection";

export interface VersionedStore<T extends { id: string }> {
  rows: SyncedCollection<T>;
  /** The version of each row, kept after it's removed. */
  versions: Map<string, number>;
  /** By query hash: when its latest fetch started. */
  fetchStartedAt: Map<string, number>;
  clock: { now: number };
}

export function createVersionedStore<T extends { id: string }>(
  rows: SyncedCollection<T>
): VersionedStore<T> {
  return { rows, versions: new Map(), fetchStartedAt: new Map(), clock: { now: 0 } };
}

function tick(store: { clock: { now: number } }): number {
  return ++store.clock.now;
}

/** Writes rows from an event or mutation response. */
export function writeLiveRows<T extends { id: string }>(store: VersionedStore<T>, rows: T[]): void {
  const now = tick(store);
  for (const row of rows) store.versions.set(row.id, now);
  store.rows.upsert(rows);
}

/** Returns the removal's version, for `restoreRemovedRow`. */
export function removeLiveRows<T extends { id: string }>(
  store: VersionedStore<T>,
  ids: string[]
): number {
  const now = tick(store);
  for (const id of ids) store.versions.set(id, now);
  store.rows.remove(ids);
  return now;
}

/**
 * Undoes an optimistic removal, unless something has written the row since
 * (say, its deletion event arrived before the mutation failed).
 */
export function restoreRemovedRow<T extends { id: string }>(
  store: VersionedStore<T>,
  row: T,
  removedAt: number
): void {
  if (store.versions.get(row.id) === removedAt) writeLiveRows(store, [row]);
}

export function markFetchStarted<T extends { id: string }>(
  store: VersionedStore<T>,
  queryHash: string
): void {
  store.fetchStartedAt.set(queryHash, tick(store));
}

/** The version a fetch's rows get: when it started, or before everything for data it didn't fetch (hydrated, seeded). */
export function fetchVersion<T extends { id: string }>(
  store: VersionedStore<T>,
  queryHash: string
): number {
  return store.fetchStartedAt.get(queryHash) ?? 0;
}

/** Whether a row a fetch at `version` returned is newer than the stored one. */
export function isFetchedRowFresh<T extends { id: string }>(
  store: VersionedStore<T>,
  id: string,
  version: number
): boolean {
  return (store.versions.get(id) ?? -1) < version;
}

/** Stores rows a fetch at `version` returned, except over a newer version. */
export function storeFetchedRows<T extends { id: string }>(
  store: VersionedStore<T>,
  version: number,
  rows: T[]
): void {
  const fresh = rows.filter((row) => isFetchedRowFresh(store, row.id, version));
  for (const row of fresh) store.versions.set(row.id, version);
  store.rows.upsert(fresh);
}

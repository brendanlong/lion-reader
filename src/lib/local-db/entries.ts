/**
 * The normalized entry store: one row per entry, holding the list-item fields
 * (no content — that stays in `entries.get`). Every server write goes through
 * here and is guarded by `updatedAt` (the server's
 * `GREATEST(entry.updated_at, user_entry.updated_at)`), so a slow page fetch
 * or an out-of-order mutation response can never overwrite newer state.
 */

import type { SyncedCollection } from "./synced-collection";

export type EntryRow = {
  id: string;
  feedId: string;
  subscriptionId: string | null;
  type: "web" | "email" | "saved";
  url: string | null;
  title: string | null;
  author: string | null;
  summary: string | null;
  publishedAt: Date | null;
  fetchedAt: Date;
  updatedAt: Date;
  read: boolean;
  starred: boolean;
  feedTitle: string | null;
  siteName: string | null;
};

export type EntryStore = SyncedCollection<EntryRow>;

export function toEntryRow(entry: EntryRow): EntryRow {
  return {
    id: entry.id,
    feedId: entry.feedId,
    subscriptionId: entry.subscriptionId,
    type: entry.type,
    url: entry.url,
    title: entry.title,
    author: entry.author,
    summary: entry.summary,
    publishedAt: entry.publishedAt,
    fetchedAt: entry.fetchedAt,
    updatedAt: entry.updatedAt,
    read: entry.read,
    starred: entry.starred,
    feedTitle: entry.feedTitle,
    siteName: entry.siteName,
  };
}

function isOlderThanStored(store: EntryStore, id: string, updatedAt: Date): boolean {
  const stored = store.getSynced(id);
  return stored !== undefined && updatedAt.getTime() < stored.updatedAt.getTime();
}

/** Writes full rows from the server, skipping any older than what we hold. */
export function upsertServerEntries(store: EntryStore, rows: EntryRow[]): void {
  store.upsert(
    rows
      .filter((row) => !isOlderThanStored(store, row.id, row.updatedAt))
      .map((row) => toEntryRow(row))
  );
}

/**
 * Writes read/starred state from the server. Entries we don't hold are
 * skipped: there is nothing on screen to update, and the next fetch that
 * shows them carries their state.
 */
export function setServerEntryState(
  store: EntryStore,
  id: string,
  state: { read: boolean; starred: boolean; updatedAt: Date }
): void {
  const stored = store.getSynced(id);
  if (!stored || isOlderThanStored(store, id, state.updatedAt)) return;
  store.upsert([{ ...stored, ...state }]);
}

/**
 * Writes metadata from an `entry_updated` event. Metadata changes don't
 * conflict with read/starred state, so they always apply. `updatedAt` is left
 * alone: the event carries the entry's own timestamp, and moving the stored
 * one forward to it would make the store reject a read/starred write computed
 * just before the metadata change (e.g. the response to a mark-read racing a
 * feed refresh).
 */
export function patchServerEntryMetadata(
  store: EntryStore,
  id: string,
  metadata: Pick<EntryRow, "title" | "author" | "summary" | "url" | "publishedAt">
): void {
  const stored = store.getSynced(id);
  if (!stored) return;
  store.upsert([{ ...stored, ...metadata }]);
}

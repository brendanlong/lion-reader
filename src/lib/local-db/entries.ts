/**
 * The normalized entry store: one row per entry, holding the list-item fields
 * (no content — that stays in `entries.get`). Every server write goes through
 * `mergeServerEntry`, so a slow page fetch or an out-of-order response can
 * never overwrite newer data.
 *
 * Freshness is tracked separately for the two groups of fields that change
 * independently: the user's **state** (read/starred) and the entry's
 * **metadata** (everything else — title, summary, …). A full row carries the
 * server's `updatedAt` (`GREATEST(entry.updated_at, user_entry.updated_at)`),
 * which is at least the time of every change it includes, so it is as fresh
 * as both groups' watermarks it reaches. A state write (mutation response,
 * `entry_state_changed`) or metadata write (`entry_updated`) carries only its
 * own group and moves only that group's watermark — so a mark-read response
 * racing a feed refresh still lands, and a page fetched before an
 * `entry_updated` can't bring back the old title (#1081).
 */

import type { SyncedCollection } from "./synced-collection";

/** An entry's list-item fields as the server sends them. */
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

/** A stored entry: the server's fields plus how fresh each group of them is. */
export type StoredEntryRow = EntryRow & {
  stateUpdatedAt: Date;
  metadataUpdatedAt: Date;
};

export type EntryStore = SyncedCollection<StoredEntryRow>;

export type EntryState = Pick<EntryRow, "read" | "starred">;

/** The fields an `entry_updated` event carries. */
export type EntryMetadata = Pick<EntryRow, "title" | "author" | "summary" | "url" | "publishedAt">;

export type EntryWrite =
  /** A full row: both groups as of `row.updatedAt`. */
  | { kind: "row"; row: EntryRow }
  | { kind: "state"; state: EntryState; updatedAt: Date }
  | { kind: "metadata"; metadata: EntryMetadata; updatedAt: Date };

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

function laterOf(a: Date, b: Date): Date {
  return a.getTime() >= b.getTime() ? a : b;
}

/** Equal timestamps apply: a re-delivered event or a refetch of the same data. */
function isFresh(updatedAt: Date, watermark: Date): boolean {
  return updatedAt.getTime() >= watermark.getTime();
}

function withWatermarks(
  row: EntryRow,
  stateUpdatedAt: Date,
  metadataUpdatedAt: Date
): StoredEntryRow {
  return {
    ...row,
    stateUpdatedAt,
    metadataUpdatedAt,
    updatedAt: laterOf(stateUpdatedAt, metadataUpdatedAt),
  };
}

/**
 * The stored row after applying `write`, or undefined when it changes nothing:
 * every group it carries is older than what is stored, or it is a partial
 * write for an entry the store doesn't hold (there is nothing on screen to
 * update, and the next fetch that shows the entry carries everything).
 */
export function mergeServerEntry(
  stored: StoredEntryRow | undefined,
  write: EntryWrite
): StoredEntryRow | undefined {
  switch (write.kind) {
    case "row": {
      const row = toEntryRow(write.row);
      if (!stored) return withWatermarks(row, row.updatedAt, row.updatedAt);
      const stateFresh = isFresh(row.updatedAt, stored.stateUpdatedAt);
      const metadataFresh = isFresh(row.updatedAt, stored.metadataUpdatedAt);
      if (!stateFresh && !metadataFresh) return undefined;
      const base = metadataFresh ? row : stored;
      const state = stateFresh ? row : stored;
      return withWatermarks(
        { ...toEntryRow(base), read: state.read, starred: state.starred },
        stateFresh ? row.updatedAt : stored.stateUpdatedAt,
        metadataFresh ? row.updatedAt : stored.metadataUpdatedAt
      );
    }
    case "state":
      if (!stored || !isFresh(write.updatedAt, stored.stateUpdatedAt)) return undefined;
      return withWatermarks(
        { ...toEntryRow(stored), ...write.state },
        write.updatedAt,
        stored.metadataUpdatedAt
      );
    case "metadata":
      if (!stored || !isFresh(write.updatedAt, stored.metadataUpdatedAt)) return undefined;
      return withWatermarks(
        { ...toEntryRow(stored), ...write.metadata },
        stored.stateUpdatedAt,
        write.updatedAt
      );
  }
}

/** Writes full rows from the server (fetched pages, `entries.get`, event payloads). */
export function upsertServerEntries(store: EntryStore, rows: EntryRow[]): void {
  // A batch can hold the same entry twice (overlapping pages); later copies
  // merge against the earlier ones, not just against the store.
  const merged = new Map<string, StoredEntryRow>();
  for (const row of rows) {
    const next = mergeServerEntry(merged.get(row.id) ?? store.getSynced(row.id), {
      kind: "row",
      row,
    });
    if (next) merged.set(row.id, next);
  }
  store.upsert([...merged.values()]);
}

/** Writes read/starred state from the server (a mutation response or `entry_state_changed`). */
export function setServerEntryState(
  store: EntryStore,
  id: string,
  state: EntryState & { updatedAt: Date }
): void {
  const next = mergeServerEntry(store.getSynced(id), {
    kind: "state",
    state: { read: state.read, starred: state.starred },
    updatedAt: state.updatedAt,
  });
  if (next) store.upsert([next]);
}

/** Writes metadata from an `entry_updated` event. */
export function patchServerEntryMetadata(
  store: EntryStore,
  id: string,
  metadata: EntryMetadata,
  updatedAt: Date
): void {
  const next = mergeServerEntry(store.getSynced(id), { kind: "metadata", metadata, updatedAt });
  if (next) store.upsert([next]);
}

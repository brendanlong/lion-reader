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
 * which is at least the time of every change it includes, so its state is as
 * fresh as that. Its metadata is as fresh as `entryUpdatedAt`
 * (`entry.updated_at` alone), the clock `entry_updated` is stamped with: judged
 * by `updatedAt`, a page fetched after a mark-read would look newer than a
 * feed update that committed just after it, and drop its title (#1759).
 * A state write (mutation response, `entry_state_changed`) or metadata write
 * (`entry_updated`) carries only its own group and moves only that group's
 * watermark — so a mark-read response
 * racing a feed refresh still lands, and a page fetched before an
 * `entry_updated` can't bring back the old title (#1081).
 */

import type { SyncedCollection } from "./synced-collection";
import type { EntryType } from "@/lib/entry-types";

/** An entry's list-item fields as the server sends them. */
export type EntryRow = {
  id: string;
  /** The entry's origin: its web, email or saved subscription (#1846). */
  subscriptionId: string | null;
  /**
   * Every active subscription holding the entry (its origin, its collections,
   * and for a saved article the saved subscription): list membership is
   * judged by these, never by `type`. Per-user, so it moves with the state
   * group (a membership change moves the server's `user_entries.updated_at`).
   */
  subscriptionIds: string[];
  /** Its position in each of those collections that gives it one (#2064); state group too. */
  positions: Record<string, number>;
  type: EntryType;
  url: string | null;
  title: string | null;
  author: string | null;
  summary: string | null;
  publishedAt: Date | null;
  fetchedAt: Date;
  updatedAt: Date;
  /**
   * When the entry's own fields last changed. Absent from a live new_entry,
   * whose metadata then counts as fresh as `updatedAt`.
   */
  entryUpdatedAt?: Date;
  read: boolean;
  starred: boolean;
  /** The user's score for it (#2064), or null; state group. */
  score: number | null;
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

/** A state write; the memberships, positions and score when the write carries them. */
type EntryStateWrite = EntryState &
  Partial<Pick<EntryRow, "subscriptionIds" | "positions" | "score">>;

/** The fields an `entry_updated` event carries. */
export type EntryMetadata = Pick<EntryRow, "title" | "author" | "summary" | "url" | "publishedAt">;

export type EntryWrite =
  /** A full row: its state as of `updatedAt`, its metadata as of `entryUpdatedAt`. */
  | { kind: "row"; row: EntryRow }
  | { kind: "state"; state: EntryStateWrite; updatedAt: Date }
  | { kind: "metadata"; metadata: EntryMetadata; updatedAt: Date };

/**
 * Just the list-item fields: what is written here often carries more (an
 * `entries.get` result's content, `readChangedAt`, the stored watermarks),
 * which the store must not keep.
 */
function toEntryRow(entry: EntryRow): EntryRow {
  return {
    id: entry.id,
    subscriptionId: entry.subscriptionId,
    subscriptionIds: entry.subscriptionIds,
    positions: entry.positions,
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
    score: entry.score,
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
      const rowMetadataUpdatedAt = write.row.entryUpdatedAt ?? row.updatedAt;
      if (!stored) return withWatermarks(row, row.updatedAt, rowMetadataUpdatedAt);
      const stateFresh = isFresh(row.updatedAt, stored.stateUpdatedAt);
      const metadataFresh = isFresh(rowMetadataUpdatedAt, stored.metadataUpdatedAt);
      if (!stateFresh && !metadataFresh) return undefined;
      const base = metadataFresh ? row : stored;
      const state = stateFresh ? row : stored;
      return withWatermarks(
        {
          ...toEntryRow(base),
          read: state.read,
          starred: state.starred,
          score: state.score,
          subscriptionIds: state.subscriptionIds,
          positions: state.positions,
        },
        stateFresh ? row.updatedAt : stored.stateUpdatedAt,
        metadataFresh ? rowMetadataUpdatedAt : stored.metadataUpdatedAt
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

/**
 * Writes read/starred state from the server (a mutation response or
 * `entry_state_changed`), and the entry's `subscriptionIds`, `positions` and
 * `score` when it carries them (read with the same row, so as fresh as the
 * state).
 */
export function setServerEntryState(
  store: EntryStore,
  id: string,
  state: EntryStateWrite & { updatedAt: Date }
): void {
  const next = mergeServerEntry(store.getSynced(id), {
    kind: "state",
    state: {
      read: state.read,
      starred: state.starred,
      ...(state.subscriptionIds && { subscriptionIds: state.subscriptionIds }),
      ...(state.positions && { positions: state.positions }),
      ...(state.score !== undefined && { score: state.score }),
    },
    updatedAt: state.updatedAt,
  });
  if (next) store.upsert([next]);
}

/**
 * Adds a collection to (or removes it from) a stored entry's
 * `subscriptionIds`, with its position there when the change carries one, after
 * a membership change. The change's response carries
 * no `updatedAt`, so this moves no watermark: a page fetched before the change
 * that lands after it can revert the ids, which only matters until the next
 * write that carries them (any unread flip does).
 */
export function setStoredEntryCollection(
  store: EntryStore,
  id: string,
  collectionId: string,
  added: boolean,
  position?: number
): void {
  const stored = store.getSynced(id);
  if (!stored || stored.subscriptionIds.includes(collectionId) === added) return;
  const subscriptionIds = added
    ? [...stored.subscriptionIds, collectionId]
    : stored.subscriptionIds.filter((subscriptionId) => subscriptionId !== collectionId);
  const positions =
    added && position !== undefined
      ? { ...stored.positions, [collectionId]: position }
      : withoutKey(stored.positions, collectionId);
  store.upsert([{ ...stored, subscriptionIds, positions }]);
}

/** Drops a deleted subscription from the stored entries' `subscriptionIds`. */
export function removeStoredEntryMemberships(store: EntryStore, subscriptionId: string): void {
  store.upsert(
    store
      .allSynced()
      .filter((entry) => entry.subscriptionIds.includes(subscriptionId))
      .map((entry) => ({
        ...entry,
        subscriptionIds: entry.subscriptionIds.filter((id) => id !== subscriptionId),
        positions: withoutKey(entry.positions, subscriptionId),
      }))
  );
}

function withoutKey(positions: Record<string, number>, key: string): Record<string, number> {
  if (!(key in positions)) return positions;
  return Object.fromEntries(Object.entries(positions).filter(([id]) => id !== key));
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

/**
 * Sets the source name of every stored entry from a subscription, after a
 * rename (`subscription_updated`). The server sends an entry's `feedTitle` as
 * its subscription's displayed title, but a rename doesn't touch the entries,
 * so no entry event or delta re-delivers them.
 */
export function setSubscriptionEntriesFeedTitle(
  store: EntryStore,
  subscriptionId: string,
  feedTitle: string | null
): void {
  store.upsert(
    store
      .allSynced()
      .filter((row) => row.subscriptionId === subscriptionId && row.feedTitle !== feedTitle)
      .map((row) => ({ ...row, feedTitle }))
  );
}

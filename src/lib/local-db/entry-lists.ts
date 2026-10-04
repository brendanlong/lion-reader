/**
 * Entry list membership: which entries each loaded `entries.list` view shows,
 * as rows `{ listKey, entryId, order }` joined against the entry store at
 * render time. A list's membership only changes when the list is fetched
 * (a full refetch replaces it, a next page adds to it), when a live event
 * inserts an entry that belongs in it, or when an entry is added to the
 * collection a list shows — never when an entry's state changes or it leaves
 * a collection,
 * so read entries stay visible in unread-only views until the list refreshes
 * on navigation.
 */

import { hashKey } from "@tanstack/react-query";
import type { EntryRow } from "./entries";
import type { SyncedCollection } from "./synced-collection";

export type ListEntryRow = {
  key: string;
  listKey: string;
  entryId: string;
  /** Ascending sort position within the list (see `listOrder`). */
  order: number;
};

/** The `entries.list` input keys that decide membership (plus the page size). */
export interface EntryListFilters {
  subscriptionId?: string;
  tagId?: string;
  uncategorized?: boolean;
  unreadOnly?: boolean;
  starredOnly?: boolean;
  sortOrder?: "newest" | "oldest";
  sortBy?: "published" | "readChanged";
  type?: "web" | "email" | "saved";
  query?: string;
  limit?: number;
}

export interface EntryListMeta {
  input: EntryListFilters & Record<string, unknown>;
  hasMore: boolean;
  /** `order` of the last loaded entry (the pagination window's edge). */
  lastOrder: number;
  entryIds: Set<string>;
  /**
   * Entries inserted live since the list's last full fetch started. That
   * fetch read the server before they existed (or became unread), so when it
   * lands and replaces the list they are kept rather than dropped.
   */
  insertedSinceFetch: Set<string>;
}

export interface EntryLists {
  rows: SyncedCollection<ListEntryRow>;
  meta: Map<string, EntryListMeta>;
}

/**
 * The list identity for an `entries.list` input — the input minus the
 * pagination fields tRPC also strips from infinite query keys, so the key
 * computed from a component's input matches the one from the query cache.
 */
export function entryListKey(input: object): string {
  const filters: Record<string, unknown> = { ...input };
  delete filters.cursor;
  delete filters.direction;
  return hashKey([filters]);
}

function listEntryKey(listKey: string, entryId: string): string {
  return `${listKey}\n${entryId}`;
}

/** Search results and Recently Read are ordered by fields entries don't carry. */
function isServerOrdered(input: EntryListFilters): boolean {
  return !!input.query || (input.sortBy !== undefined && input.sortBy !== "published");
}

/**
 * Newest-first lists sort descending by `COALESCE(publishedAt, fetchedAt)`,
 * then id. `order` is stored ascending (negated for newest-first) so every
 * list sorts `order ASC`; the id tiebreak direction comes from
 * `isNewestFirst`. Server-ordered lists use their fetch position.
 */
function listOrder(input: EntryListFilters, entry: EntryRow, index: number): number {
  if (isServerOrdered(input)) return index;
  const time = (entry.publishedAt ?? entry.fetchedAt).getTime();
  return input.sortOrder === "oldest" ? time : -time;
}

export function isNewestFirst(input: EntryListFilters): boolean {
  return input.sortOrder !== "oldest";
}

/** Call when a full (not next-page) fetch of the list starts. */
export function markEntryListFetchStarted(lists: EntryLists, input: Record<string, unknown>): void {
  lists.meta.get(entryListKey(input))?.insertedSinceFetch.clear();
}

/**
 * Records a fetched list. `replace` (initial load, refetch) drops entries the
 * server no longer returned, except those inserted live after the fetch
 * started; `append` (next page) keeps everything already in the list,
 * including entries inserted live while the page was loading.
 */
export function ingestEntryListPages(
  lists: EntryLists,
  input: EntryListMeta["input"],
  pages: Array<{ items: EntryRow[]; nextCursor?: string }>,
  mode: "replace" | "append"
): void {
  const listKey = entryListKey(input);
  const previous = lists.meta.get(listKey);
  const rows = pages
    .flatMap((page) => page.items)
    .map((entry, index): ListEntryRow => ({
      key: listEntryKey(listKey, entry.id),
      listKey,
      entryId: entry.id,
      order: listOrder(input, entry, index),
    }));

  const hasMore = pages.at(-1)?.nextCursor !== undefined;
  const lastOrder = rows.at(-1)?.order ?? -Infinity;
  const entryIds = new Set(rows.map((row) => row.entryId));
  if (mode === "append" && previous) {
    for (const id of previous.entryIds) entryIds.add(id);
  } else if (previous) {
    // Kept only within the new pagination window: past it, the entry would
    // render after a gap of unloaded entries (the next page brings it back).
    for (const id of previous.insertedSinceFetch) {
      const order = lists.rows.getSynced(listEntryKey(listKey, id))?.order;
      if (order !== undefined && (!hasMore || order <= lastOrder)) entryIds.add(id);
    }
    lists.rows.remove(
      [...previous.entryIds]
        .filter((id) => !entryIds.has(id))
        .map((id) => listEntryKey(listKey, id))
    );
  }

  lists.rows.upsert(rows.filter((row) => lists.rows.getSynced(row.key)?.order !== row.order));
  lists.meta.set(listKey, {
    input,
    hasMore,
    lastOrder,
    entryIds,
    insertedSinceFetch: mode === "append" && previous ? previous.insertedSinceFetch : new Set(),
  });
}

export function removeEntryList(lists: EntryLists, input: Record<string, unknown>): void {
  const listKey = entryListKey(input);
  const meta = lists.meta.get(listKey);
  if (!meta) return;
  lists.rows.remove([...meta.entryIds].map((id) => listEntryKey(listKey, id)));
  lists.meta.delete(listKey);
}

/**
 * The `entries.list` input keys `insertIntoMatchingLists` knows how to honor.
 * Lists whose input contains any other key are skipped (fail-safe: the entry
 * appears on the next navigation-triggered refresh instead of live), so a
 * future filter added to entries.list can't silently receive wrong inserts.
 */
const INSERT_SUPPORTED_FILTER_KEYS = new Set([
  "subscriptionId",
  "tagId",
  "uncategorized",
  "unreadOnly",
  "starredOnly",
  "sortOrder",
  "sortBy",
  "type",
  "query",
  "limit",
]);

/**
 * Which tags the entry's subscription has. `undefined` when the subscription
 * isn't known, in which case tag and uncategorized lists are conservatively
 * skipped. Saved articles (no subscription) belong to no tag list, so an
 * empty scope is exact for them.
 */
export interface EntryTagScope {
  tagIds: Set<string>;
  uncategorized: boolean;
}

function belongsInList(
  input: EntryListFilters,
  entry: EntryRow,
  scope: EntryTagScope | undefined
): boolean {
  if (input.subscriptionId && input.subscriptionId !== entry.subscriptionId) return false;
  if (input.tagId && !scope?.tagIds.has(input.tagId)) return false;
  if (input.uncategorized && !scope?.uncategorized) return false;
  if (input.starredOnly && !entry.starred) return false;
  if (input.unreadOnly && entry.read) return false;
  if (input.type && input.type !== entry.type) return false;
  return true;
}

/**
 * Inserts an entry into every loaded list it belongs in, so it appears live
 * without a refetch (new entries, and entries that became unread and so now
 * belong in unread-only lists fetched while they were read).
 *
 * Skips lists whose membership or ordering can't be reproduced client-side
 * (search, Recently Read, unknown filter keys) and inserts that sort past the
 * loaded pagination window (they arrive with the page that covers them).
 * Idempotent: an entry already in a list is left alone.
 */
export function insertIntoMatchingLists(
  lists: EntryLists,
  entry: EntryRow,
  scope: EntryTagScope | undefined
): void {
  insertIntoListsWhere(lists, entry, (input) => belongsInList(input, entry, scope));
}

/**
 * Inserts an entry into the loaded lists of a collection it was just added
 * to. A collection's membership isn't one of the entry's fields, so
 * `insertIntoMatchingLists` can't place it; tag lists the collection is in
 * pick it up on their next refresh.
 */
export function insertIntoCollectionLists(
  lists: EntryLists,
  entry: EntryRow,
  collectionId: string
): void {
  insertIntoListsWhere(
    lists,
    entry,
    (input) =>
      input.subscriptionId === collectionId &&
      belongsInList({ ...input, subscriptionId: undefined }, entry, undefined)
  );
}

function insertIntoListsWhere(
  lists: EntryLists,
  entry: EntryRow,
  belongs: (input: EntryListMeta["input"]) => boolean
): void {
  const rows: ListEntryRow[] = [];
  for (const [listKey, meta] of lists.meta) {
    const { input } = meta;
    if (meta.entryIds.has(entry.id) || isServerOrdered(input)) continue;
    const hasUnknownFilter = Object.keys(input).some(
      (key) => input[key] !== undefined && !INSERT_SUPPORTED_FILTER_KEYS.has(key)
    );
    if (hasUnknownFilter || !belongs(input)) continue;

    const order = listOrder(input, entry, 0);
    if (meta.hasMore && order > meta.lastOrder) continue;

    meta.entryIds.add(entry.id);
    meta.insertedSinceFetch.add(entry.id);
    rows.push({ key: listEntryKey(listKey, entry.id), listKey, entryId: entry.id, order });
  }
  lists.rows.upsert(rows);
}

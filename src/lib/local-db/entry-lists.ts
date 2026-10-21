/**
 * Entry list membership: which entries each loaded `entries.list` view shows,
 * as rows `{ listKey, entryId, order }` joined against the entry store at
 * render time. A list's membership only changes when the list is fetched
 * (a full refetch replaces it, a next page adds to it), when a live event
 * inserts an entry that belongs in it, or when an entry joins or leaves the
 * collection a list shows — never when an entry's state changes, so read
 * entries stay visible in unread-only views until the list refreshes on
 * navigation.
 */

import { hashKey } from "@tanstack/react-query";
import type { EntryRow } from "./entries";
import type { SyncedCollection } from "./synced-collection";
import type { EntryType } from "@/lib/entry-types";
import { ENTRY_SORT_DIRECTIONS, isRankedSort, type EntrySortOrder } from "@/lib/entry-sort";

export type ListEntryRow = {
  key: string;
  listKey: string;
  entryId: string;
  /** Its place in the list (see `listOrder`). */
  order: ListOrder;
  /**
   * Left the collection the list shows. The row stays so the list keeps its
   * place while the entry is open, but renders only as the open entry.
   */
  removed: boolean;
};

/** The `entries.list` input keys that decide membership (plus the page size). */
export interface EntryListFilters {
  subscriptionId?: string;
  tagId?: string;
  uncategorized?: boolean;
  unreadOnly?: boolean;
  starredOnly?: boolean;
  sortOrder?: EntrySortOrder;
  sortBy?: "published" | "readChanged" | "score" | "position";
  type?: EntryType;
  query?: string;
  limit?: number;
}

export interface EntryListMeta {
  input: EntryListFilters & Record<string, unknown>;
  hasMore: boolean;
  /** The sort the server listed it in (its first page's `sort`). */
  sort?: ListSort;
  /** The last loaded entry's place (the pagination window's edge). */
  last?: ListPlace;
  entryIds: Set<string>;
  /**
   * Entries inserted live since the list's last full fetch started. That
   * fetch read the server before they existed (or became unread), so when it
   * lands and replaces the list they are kept rather than dropped.
   */
  insertedSinceFetch: Set<string>;
  /** Likewise, entries removed live since then stay removed when it lands. */
  removedSinceFetch: Set<string>;
}

export interface EntryLists {
  rows: SyncedCollection<ListEntryRow>;
  meta: Map<string, EntryListMeta>;
  /** Which ranked sorts each loaded list has values for, by list key. */
  sortable: SyncedCollection<ListSortableRow>;
}

/**
 * Which ranked sorts a list has values for (`entries.list`'s `sortable`),
 * kept live, and the sort its first page came in (`sort`).
 */
export type ListSortableRow = {
  listKey: string;
  score: boolean;
  position: boolean;
  sort?: ListSort;
};

/** The sort a list came in: the one asked for, or with none, the list's default. */
export type ListSort = {
  sortBy: "published" | "readChanged" | "score" | "position";
  sortOrder: EntrySortOrder;
};

/** A list's filters with the sort it's in: the one asked for, or the server's. */
function sortedInput(input: EntryListFilters, sort: ListSort | undefined): EntryListFilters {
  if (input.sortOrder || !sort) return input;
  return { ...input, sortBy: sort.sortBy, sortOrder: sort.sortOrder };
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
  return !!input.query || input.sortBy === "readChanged";
}

/**
 * An entry's place in a list: `keys` compared in order, ascending, then the
 * entry id, descending when `descendingId`. A list ordered by date is
 * `[±COALESCE(publishedAt, fetchedAt)]`; by score or position, entries
 * without a value come after the rest, newest first, as the server orders
 * them (#2064): `[0, ±value, ±time]` for those with one, `[1, 0, -time]` for
 * those without. Server-ordered lists use their fetch position.
 */
export type ListOrder = { keys: number[]; descendingId: boolean };

/** An entry's place in a list, with the id its order breaks ties by. */
export type ListPlace = { order: ListOrder; entryId: string };

type EntrySortFields = Pick<EntryRow, "id" | "publishedAt" | "fetchedAt" | "score" | "positions">;

function listOrder(input: EntryListFilters, entry: EntrySortFields, index: number): ListOrder {
  if (isServerOrdered(input)) return { keys: [index], descendingId: false };
  const time = entrySortKey(entry);
  const sortBy = isRankedSort(input.sortBy) ? input.sortBy : "published";
  const reversed = isReversed(input, sortBy);
  if (sortBy === "published") {
    return reversed ? { keys: [time], descendingId: false } : { keys: [-time], descendingId: true };
  }
  const value =
    sortBy === "score"
      ? entry.score
      : input.subscriptionId
        ? entry.positions[input.subscriptionId]
        : undefined;
  if (value === null || value === undefined) return { keys: [1, 0, -time], descendingId: true };
  // A score sorts highest first and a position lowest first; reversing flips
  // the value and the date within it.
  const descending = (sortBy === "score") !== reversed;
  return descending
    ? { keys: [0, -value, -time], descendingId: true }
    : { keys: [0, value, time], descendingId: false };
}

function isReversed(input: EntryListFilters, sortBy: "published" | "score" | "position"): boolean {
  return input.sortOrder === ENTRY_SORT_DIRECTIONS[sortBy][1];
}

/** Orders two places in one list. */
export function comparePlaces(a: ListPlace, b: ListPlace): number {
  const keys = Math.max(a.order.keys.length, b.order.keys.length);
  for (let i = 0; i < keys; i++) {
    const diff = (a.order.keys[i] ?? 0) - (b.order.keys[i] ?? 0);
    if (diff !== 0) return diff;
  }
  if (a.entryId === b.entryId) return 0;
  const ascending = a.entryId < b.entryId ? -1 : 1;
  return a.order.descendingId ? -ascending : ascending;
}

function sameOrder(a: ListOrder, b: ListOrder): boolean {
  return (
    a.descendingId === b.descendingId &&
    a.keys.length === b.keys.length &&
    a.keys.every((key, i) => key === b.keys[i])
  );
}

/** An entry's place in a published-order list: `COALESCE(publishedAt, fetchedAt)`, then id. */
function entrySortKey(entry: Pick<EntryRow, "publishedAt" | "fetchedAt">): number {
  return (entry.publishedAt ?? entry.fetchedAt).getTime();
}

/** Orders entries as a list with these filters shows them (not server-ordered ones). */
export function compareListEntries(
  input: EntryListFilters
): (a: EntrySortFields, b: EntrySortFields) => number {
  return (a, b) =>
    comparePlaces(
      { order: listOrder(input, a, 0), entryId: a.id },
      { order: listOrder(input, b, 0), entryId: b.id }
    );
}

/** Call when a full (not next-page) fetch of the list starts. */
export function markEntryListFetchStarted(lists: EntryLists, input: Record<string, unknown>): void {
  const meta = lists.meta.get(entryListKey(input));
  meta?.insertedSinceFetch.clear();
  meta?.removedSinceFetch.clear();
}

/**
 * Records a fetched list. `replace` (initial load, refetch) drops entries the
 * server no longer returned, except those inserted live after the fetch
 * started; `append` (next page) keeps everything already in the list,
 * including entries inserted live while the page was loading. Either way,
 * entries removed live after the fetch started stay removed.
 */
export function ingestEntryListPages(
  lists: EntryLists,
  input: EntryListMeta["input"],
  pages: Array<{
    items: EntryRow[];
    nextCursor?: string;
    sortable?: Pick<ListSortableRow, "score" | "position">;
    sort?: ListSort;
  }>,
  mode: "replace" | "append"
): void {
  const listKey = entryListKey(input);
  const previous = lists.meta.get(listKey);
  const removedSinceFetch = previous?.removedSinceFetch ?? new Set<string>();
  // A next page's first is the earlier fetch's, whose sort is already stored.
  const sort = (mode === "replace" ? pages[0]?.sort : undefined) ?? previous?.sort;
  const orderInput = sortedInput(input, sort);
  const rows = pages
    .flatMap((page) => page.items)
    .map((entry, index): ListEntryRow => ({
      key: listEntryKey(listKey, entry.id),
      listKey,
      entryId: entry.id,
      order: listOrder(orderInput, entry, index),
      removed:
        removedSinceFetch.has(entry.id) ||
        (mode === "append" && !!lists.rows.getSynced(listEntryKey(listKey, entry.id))?.removed),
    }));

  const hasMore = pages.at(-1)?.nextCursor !== undefined;
  const lastRow = rows.at(-1);
  const last = lastRow && { order: lastRow.order, entryId: lastRow.entryId };
  const entryIds = new Set(rows.map((row) => row.entryId));
  if (mode === "append" && previous) {
    for (const id of previous.entryIds) entryIds.add(id);
  } else if (previous) {
    // Kept only within the new pagination window: past it, the entry would
    // render after a gap of unloaded entries (the next page brings it back).
    for (const id of previous.insertedSinceFetch) {
      const order = lists.rows.getSynced(listEntryKey(listKey, id))?.order;
      if (order && (!hasMore || !last || comparePlaces({ order, entryId: id }, last) <= 0)) {
        entryIds.add(id);
      }
    }
    lists.rows.remove(
      [...previous.entryIds]
        .filter((id) => !entryIds.has(id))
        .map((id) => listEntryKey(listKey, id))
    );
  }

  lists.rows.upsert(
    rows.filter((row) => {
      const stored = lists.rows.getSynced(row.key);
      return !stored || !sameOrder(stored.order, row.order) || stored.removed !== row.removed;
    })
  );
  const keepsLiveChanges = mode === "append" && previous;
  lists.meta.set(listKey, {
    input,
    hasMore,
    sort,
    last,
    entryIds,
    insertedSinceFetch: keepsLiveChanges ? previous.insertedSinceFetch : new Set(),
    removedSinceFetch: keepsLiveChanges ? previous.removedSinceFetch : new Set(),
  });
  // A next page's first is the earlier fetch's: live changes since may be newer.
  const sortable = pages[0]?.sortable;
  if (mode === "replace" && sortable) lists.sortable.upsert([{ listKey, ...sortable, sort }]);
}

export function removeEntryList(lists: EntryLists, input: Record<string, unknown>): void {
  const listKey = entryListKey(input);
  const meta = lists.meta.get(listKey);
  if (!meta) return;
  lists.rows.remove([...meta.entryIds].map((id) => listEntryKey(listKey, id)));
  lists.meta.delete(listKey);
  lists.sortable.remove([listKey]);
}

/**
 * Records that lists now have a value for a ranked sort, as an entry gained
 * a score or a position live: every loaded list `includes`, which the
 * caller judges by the entry's memberships and state. Values going away
 * leave the sort offered until the list's next fetch, which shows it by date
 * while nothing has a value.
 */
export function markListsSortable(
  lists: EntryLists,
  sort: "score" | "position",
  includes: (input: EntryListMeta["input"]) => boolean
): void {
  const rows: ListSortableRow[] = [];
  for (const [listKey, meta] of lists.meta) {
    const row = lists.sortable.getSynced(listKey);
    if (!row || row[sort] || !includes(meta.input)) continue;
    rows.push({ ...row, [sort]: true });
  }
  lists.sortable.upsert(rows);
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
 * The lists an entry's memberships (`subscriptionIds`) put it in, as far as
 * the client knows them: the tags of its known subscriptions, whether one of
 * them is untagged (Uncategorized; never the saved subscription), and whether
 * it's in the saved subscription (Saved). Built only from what the client
 * knows, so it can miss a list (the entry then appears on that list's next
 * refresh) but never claims a wrong one.
 */
export interface EntryMembershipScope {
  tagIds: Set<string>;
  uncategorized: boolean;
  saved: boolean;
}

/**
 * @param tagIdsOf - A known subscription's tag ids, or undefined for one the
 *   caller doesn't know
 */
export function entryMembershipScope(
  subscriptionIds: readonly string[],
  savedSubscriptionId: string | null | undefined,
  tagIdsOf: (subscriptionId: string) => readonly string[] | undefined
): EntryMembershipScope {
  const tagIds = new Set<string>();
  let uncategorized = false;
  for (const id of subscriptionIds) {
    // Uncategorized excludes the saved subscription, whatever its tags.
    if (id === savedSubscriptionId) continue;
    const subscriptionTagIds = tagIdsOf(id);
    if (!subscriptionTagIds) continue;
    for (const tagId of subscriptionTagIds) tagIds.add(tagId);
    if (subscriptionTagIds.length === 0) uncategorized = true;
  }
  return {
    tagIds,
    uncategorized,
    saved: !!savedSubscriptionId && subscriptionIds.includes(savedSubscriptionId),
  };
}

/**
 * Whether an entry passes a list's membership and state filters. Search and
 * ordering-only keys aren't checked; callers that can't honor them skip such
 * lists (see `insertIntoMatchingLists`).
 */
export function entryMatchesList(
  input: EntryListFilters,
  entry: Pick<EntryRow, "subscriptionIds" | "read" | "starred" | "type">,
  scope: EntryMembershipScope
): boolean {
  if (input.subscriptionId && !entry.subscriptionIds.includes(input.subscriptionId)) return false;
  if (input.tagId && !scope.tagIds.has(input.tagId)) return false;
  if (input.uncategorized && !scope.uncategorized) return false;
  if (input.starredOnly && !entry.starred) return false;
  if (input.unreadOnly && entry.read) return false;
  // Saved is a membership, like a collection; other types filter on the entry's.
  if (input.type === "saved" ? !scope.saved : input.type && input.type !== entry.type) {
    return false;
  }
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
  scope: EntryMembershipScope
): void {
  insertIntoListsWhere(lists, entry, (input) => entryMatchesList(input, entry, scope));
}

/**
 * Marks an entry as having left (or rejoined) a collection in every loaded
 * list of it, whatever its other filters (they can only narrow the
 * collection). Recorded even where the entry isn't loaded yet, so a page
 * already in flight can't show it.
 */
export function setLeftCollectionLists(
  lists: EntryLists,
  entryId: string,
  collectionId: string,
  left: boolean
): void {
  const rows: ListEntryRow[] = [];
  for (const [listKey, meta] of lists.meta) {
    if (meta.input.subscriptionId !== collectionId) continue;
    if (left) {
      meta.insertedSinceFetch.delete(entryId);
      meta.removedSinceFetch.add(entryId);
    } else {
      meta.removedSinceFetch.delete(entryId);
    }
    const row = lists.rows.getSynced(listEntryKey(listKey, entryId));
    if (!row || row.removed === left) continue;
    // A rejoined row is a live change the next fetch may predate.
    if (!left) meta.insertedSinceFetch.add(entryId);
    rows.push({ ...row, removed: left });
  }
  lists.rows.upsert(rows);
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

    const order = listOrder(sortedInput(input, meta.sort), entry, 0);
    if (meta.hasMore && meta.last && comparePlaces({ order, entryId: entry.id }, meta.last) > 0) {
      continue;
    }

    meta.entryIds.add(entry.id);
    meta.insertedSinceFetch.add(entry.id);
    rows.push({
      key: listEntryKey(listKey, entry.id),
      listKey,
      entryId: entry.id,
      order,
      removed: false,
    });
  }
  lists.rows.upsert(rows);
}

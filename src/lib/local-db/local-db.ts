/**
 * The client-side normalized store (TanStack DB) for entries and entry list
 * membership. React Query remains the network layer: `entries.list` and
 * `entries.get` results are ingested from the query cache as they land (a
 * QueryCache subscription, so SSR-hydrated, prefetched and fetched data all
 * take the same path), and components render from the store.
 *
 * One store per QueryClient, never module-global: on the server each request
 * has its own QueryClient, and a shared store would leak one user's entries
 * into another's render.
 */

import type { Query, QueryClient } from "@tanstack/react-query";
import { BasicIndex } from "@tanstack/db";
import { toEntryRow, upsertServerEntries, type EntryRow, type EntryStore } from "./entries";
import {
  createEntryLists,
  ingestEntryListPages,
  insertIntoMatchingLists,
  markEntryListFetchStarted,
  removeEntryList,
  writeListRows,
  type EntryListMeta,
  type EntryLists,
  type EntryTagScope,
  type ListEntryRow,
} from "./entry-lists";
import type { ListFetch, LocalPersistence } from "./persistence";
import { findCachedSubscription } from "@/lib/cache/count-cache";
import { createSyncedCollection } from "./synced-collection";

export interface LocalDb {
  entries: EntryStore;
  lists: EntryLists;
  /** Set once local persistence is attached; the store is memory-only until then. */
  persistence: LocalPersistence | null;
  /** An attach in progress, so a second one isn't started meanwhile. */
  attaching: Promise<void> | null;
}

interface EntriesListData {
  pages: Array<{ items: EntryRow[]; nextCursor?: string }>;
}

let nextDbId = 0;

function createLocalDb(): LocalDb {
  // Collection ids feed live-query identity hashes, so each store's must be
  // distinct from every other store's.
  const dbId = nextDbId++;
  const entries = createSyncedCollection<EntryRow>({
    id: `entries-${dbId}`,
    getKey: (row) => row.id,
  });
  const rows = createSyncedCollection<ListEntryRow>({
    id: `entry-list-rows-${dbId}`,
    getKey: (row) => row.key,
  });
  rows.collection.createIndex((row) => row.listKey, { indexType: BasicIndex });
  rows.collection.createIndex((row) => row.entryId, { indexType: BasicIndex });
  return { entries, lists: createEntryLists(rows), persistence: null, attaching: null };
}

function procedureOf(query: Query): string | undefined {
  const path = query.queryKey[0];
  return Array.isArray(path) ? path.join(".") : undefined;
}

function inputOf(query: Query): Record<string, unknown> {
  const meta = query.queryKey[1] as { input?: Record<string, unknown> } | undefined;
  return meta?.input ?? {};
}

function ingestQuery(db: LocalDb, query: Query, mode: "replace" | "append"): void {
  const data = query.state.data;
  if (!data) return;
  switch (procedureOf(query)) {
    case "entries.list":
      ingestListData(db, inputOf(query), data as EntriesListData, mode);
      break;
    case "entries.get":
      upsertServerEntries(db.entries, [toEntryRow((data as { entry: EntryRow }).entry)]);
      break;
  }
}

function ingestListData(
  db: LocalDb,
  input: Record<string, unknown>,
  data: EntriesListData,
  mode: "replace" | "append"
): void {
  upsertServerEntries(
    db.entries,
    data.pages.flatMap((page) => page.items)
  );
  ingestEntryListPages(db.lists, input as EntryListMeta["input"], data.pages, mode);
}

function connectQueryCache(db: LocalDb, queryClient: QueryClient): void {
  const cache = queryClient.getQueryCache();
  for (const query of cache.getAll()) {
    ingestQuery(db, query, "replace");
  }
  cache.subscribe((event) => {
    const { query } = event;
    if (event.type === "removed") {
      // A persisted list outlives its query: it is what the next session
      // shows before refetching it (and is evicted by age instead).
      if (procedureOf(query) === "entries.list" && !db.persistence) {
        removeEntryList(db.lists, inputOf(query));
      }
      return;
    }
    if (event.type === "added") {
      ingestQuery(db, query, "replace");
    } else if (
      event.type === "updated" &&
      event.action.type === "fetch" &&
      !event.action.meta?.fetchMore &&
      procedureOf(query) === "entries.list"
    ) {
      markEntryListFetchStarted(db.lists, inputOf(query));
    } else if (event.type === "updated" && event.action.type === "success") {
      // A next-page fetch appends; anything else (initial fetch, refetch,
      // setQueryData) is the list's complete current membership. `fetchMeta`
      // outlives its fetch, so a manual write after a next page is still a
      // replace. (Hydrating over an existing query is a `setState`, which
      // isn't ingested: the SPA only hydrates on its first load.)
      const isNextPage = !!query.state.fetchMeta?.fetchMore && !event.action.manual;
      ingestQuery(db, query, isNextPage ? "append" : "replace");
    }
  });
}

const dbs = new WeakMap<QueryClient, LocalDb>();

export function getLocalDb(queryClient: QueryClient): LocalDb {
  let db = dbs.get(queryClient);
  if (!db) {
    db = createLocalDb();
    dbs.set(queryClient, db);
    connectQueryCache(db, queryClient);
  }
  return db;
}

function entryTagScope(queryClient: QueryClient, entry: EntryRow): EntryTagScope | undefined {
  if (!entry.subscriptionId) return { tagIds: new Set(), uncategorized: false };
  const subscription = findCachedSubscription(queryClient, entry.subscriptionId);
  if (!subscription) return undefined;
  return {
    tagIds: new Set(subscription.tags.map((tag) => tag.id)),
    uncategorized: subscription.tags.length === 0,
  };
}

/**
 * Inserts an entry into the loaded lists it belongs in, judged by `entry`'s
 * fields. Tag/uncategorized membership comes from the cached subscription;
 * when that isn't cached, those lists are skipped and pick the entry up on
 * their next refresh.
 */
export function insertEntryIntoLists(db: LocalDb, queryClient: QueryClient, entry: EntryRow): void {
  insertIntoMatchingLists(db.lists, entry, entryTagScope(queryClient, entry));
}

/** Stores a server-provided entry and inserts it into the lists it now belongs in. */
export function addServerEntryToLists(
  db: LocalDb,
  queryClient: QueryClient,
  entry: EntryRow
): void {
  upsertServerEntries(db.entries, [entry]);
  insertEntryIntoLists(db, queryClient, db.entries.getSynced(entry.id) ?? entry);
}

/** Persisted lists not fetched for this long are dropped, with the entries only they reference. */
const PERSISTED_LIST_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Loads what a previous session persisted into the store, then mirrors every
 * later synced write ("Local Persistence" in src/FRONTEND_STATE.md).
 */
export async function attachLocalPersistence(
  db: LocalDb,
  persistence: LocalPersistence
): Promise<void> {
  const [storedEntries, storedRows, storedFetches] = await Promise.all([
    persistence.loadAll<EntryRow>("entries"),
    persistence.loadAll<ListEntryRow>("listRows"),
    persistence.loadAll<ListFetch>("listFetches"),
  ]);

  // Everything below is synchronous, so no session write can slip between
  // loading and mirroring.
  const sessionEntries = [...db.entries.syncedRows()];
  const sessionRows = [...db.lists.rows.syncedRows()];

  const now = Date.now();
  const restoredLists = new Set(
    storedFetches
      .filter((fetch) => now - fetch.fetchedAt < PERSISTED_LIST_RETENTION_MS)
      .filter((fetch) => !isSearchList(fetch.listKey))
      .map((fetch) => fetch.listKey)
      .filter((listKey) => !db.lists.meta.has(listKey))
  );
  const restoredRows = storedRows.filter((row) => restoredLists.has(row.listKey));
  const referenced = new Set(restoredRows.map((row) => row.entryId));
  const restoredEntries = storedEntries.filter((entry) => referenced.has(entry.id));

  upsertServerEntries(db.entries, restoredEntries);
  writeListRows(db.lists, restoredRows);

  persistence.delete(
    "listRows",
    storedRows.filter((row) => !restoredLists.has(row.listKey)).map((row) => row.key)
  );
  persistence.delete(
    "entries",
    storedEntries.filter((entry) => !referenced.has(entry.id)).map((entry) => entry.id)
  );
  persistence.delete(
    "listFetches",
    storedFetches.filter((fetch) => !restoredLists.has(fetch.listKey)).map((f) => f.listKey)
  );

  db.entries.setMirror({
    put: (rows) => persistence.put("entries", rows),
    delete: (keys) => persistence.delete("entries", keys),
  });
  const persistedRows = (rows: ListEntryRow[]) => rows.filter((row) => !isSearchList(row.listKey));
  db.lists.rows.setMirror({
    put: (rows) => persistence.put("listRows", persistedRows(rows)),
    delete: (keys) => persistence.delete("listRows", keys),
  });
  const recordFetched = (listKey: string) => {
    if (isSearchList(listKey)) return;
    persistence.put("listFetches", [{ listKey, fetchedAt: Date.now() } satisfies ListFetch]);
  };
  db.lists.onFetched = recordFetched;

  persistence.put("entries", sessionEntries);
  persistence.put("listRows", persistedRows(sessionRows));
  for (const listKey of db.lists.meta.keys()) recordFetched(listKey);
  db.persistence = persistence;
}

/** Stops mirroring to local persistence; the store carries on in memory. */
export function detachLocalPersistence(db: LocalDb): void {
  const noop = { put: () => {}, delete: () => {} };
  db.entries.setMirror(noop);
  db.lists.rows.setMirror(noop);
  db.lists.onFetched = undefined;
  db.persistence?.close();
  db.persistence = null;
}

/**
 * Search results aren't persisted: their list key holds the query text, and
 * results for a past search are rarely what the next visit wants first.
 */
function isSearchList(listKey: string): boolean {
  const [filters] = JSON.parse(listKey) as [{ query?: string }];
  return !!filters.query;
}

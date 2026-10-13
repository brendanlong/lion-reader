/**
 * The client-side normalized store (TanStack DB) for entries, entry list
 * membership, subscriptions, tags and unread counts. React Query remains the
 * network layer: `entries.*`, `subscriptions.list/get` and `tags.list` results
 * are ingested from the query cache as they land (a QueryCache subscription,
 * so SSR-hydrated, prefetched and fetched data all take the same path), and
 * components render from the store. Nothing patches those queries' data.
 *
 * One store per QueryClient, never module-global: on the server each request
 * has its own QueryClient, and a shared store would leak one user's entries
 * into another's render.
 */

import type { Query, QueryClient } from "@tanstack/react-query";
import { BasicIndex } from "@tanstack/db";
import {
  upsertServerEntries,
  type EntryRow,
  type EntryStore,
  type StoredEntryRow,
} from "./entries";
import {
  ingestEntryListPages,
  insertIntoMatchingLists,
  entryMembershipScope,
  markEntryListFetchStarted,
  removeEntryList,
  type EntryListMeta,
  type EntryLists,
  type ListEntryRow,
} from "./entry-lists";
import { createSyncedCollection } from "./synced-collection";
import {
  ingestFetchedSubscriptions,
  writeSubscriptionCount,
  type FetchedSubscriptionRow,
  type SubscriptionPages,
  type SubscriptionRow,
  type SubscriptionStore,
} from "./subscriptions";
import {
  countedListOf,
  removeTagCount,
  writeCounts,
  type CountRow,
  type CountStore,
} from "./counts";
import { ingestFetchedTags, type TagRow, type TagStore } from "./tags";
import { createVersionedStore, markFetchStarted } from "./versioned-store";
import type { TRPCClientUtils } from "@/lib/trpc/client";

export interface LocalDb {
  entries: EntryStore;
  lists: EntryLists;
  subscriptions: SubscriptionStore;
  tags: TagStore;
  counts: CountStore;
  saved: SavedSubscription;
}

type TagsListData = NonNullable<ReturnType<TRPCClientUtils["tags"]["list"]["getData"]>>;

/**
 * The user's saved subscription (#1846), whose members are the Saved list.
 * Its id comes from `subscriptions.list` results (every one names it): null
 * before the first save creates it, undefined until a result has landed.
 * Components read it through `useSavedSubscriptionId`.
 */
export interface SavedSubscription {
  id: string | null | undefined;
  /** Whether a save already made the client look the id up while it was null. */
  lookedUp: boolean;
  listeners: Set<() => void>;
}

/**
 * Records the saved subscription's id. A known id never goes back to null: a
 * result fetched before the first save can land after it, and the saved
 * subscription is never deleted.
 */
function setSavedSubscriptionId(db: LocalDb, id: string | null): void {
  if (db.saved.id === id || (id === null && db.saved.id)) return;
  db.saved.id = id;
  for (const listener of db.saved.listeners) listener();
}

export function subscribeSavedSubscriptionId(db: LocalDb, listener: () => void): () => void {
  db.saved.listeners.add(listener);
  return () => db.saved.listeners.delete(listener);
}

interface EntriesListData {
  pages: Array<{ items: EntryRow[]; nextCursor?: string }>;
}

let nextDbId = 0;

function createLocalDb(): LocalDb {
  // Collection ids feed live-query identity hashes, so each store's must be
  // distinct from every other store's.
  const dbId = nextDbId++;
  const entries = createSyncedCollection<StoredEntryRow>({
    id: `entries-${dbId}`,
    getKey: (row) => row.id,
  });
  const rows = createSyncedCollection<ListEntryRow>({
    id: `entry-list-rows-${dbId}`,
    getKey: (row) => row.key,
  });
  rows.collection.createIndex((row) => row.listKey, { indexType: BasicIndex });
  rows.collection.createIndex((row) => row.entryId, { indexType: BasicIndex });
  const subscriptions: SubscriptionStore = {
    ...createVersionedStore(
      createSyncedCollection<SubscriptionRow>({
        id: `subscriptions-${dbId}`,
        getKey: (row) => row.id,
      })
    ),
    countAsOf: new Map(),
  };
  return {
    entries,
    lists: { rows, meta: new Map() },
    subscriptions,
    tags: createVersionedStore(
      createSyncedCollection<TagRow>({ id: `tags-${dbId}`, getKey: (row) => row.id })
    ),
    counts: {
      rows: createSyncedCollection<CountRow>({ id: `counts-${dbId}`, getKey: (row) => row.key }),
      asOf: new Map(),
    },
    saved: { id: undefined, lookedUp: false, listeners: new Set() },
  };
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
      upsertServerEntries(db.entries, [(data as { entry: EntryRow }).entry]);
      break;
    case "subscriptions.list": {
      // Infinite (the sidebar, the collection picker) or a single page.
      const list = data as SubscriptionPages | SubscriptionPages["pages"][number];
      const pages = "pages" in list ? list : { pages: [list] };
      ingestSubscriptionPages(db, query, pages, mode);
      break;
    }
    case "subscriptions.get":
      ingestFetchedSubscriptions(db.subscriptions, query.queryHash, [
        data as FetchedSubscriptionRow,
      ]);
      break;
    case "entries.count":
      ingestCount(db, inputOf(query), data as { unread: number; asOf: string });
      break;
    case "tags.list":
      ingestTags(db, query.queryHash, data as TagsListData);
      break;
  }
}

function ingestCount(
  db: LocalDb,
  input: Record<string, unknown>,
  { unread, asOf }: { unread: number; asOf: string }
): void {
  const list = countedListOf(input);
  if (list) {
    writeCounts(db.counts, [{ list, unread }], asOf);
  } else if (typeof input.subscriptionId === "string") {
    writeSubscriptionCount(db.subscriptions, input.subscriptionId, unread, asOf);
  }
}

function ingestTags(db: LocalDb, queryHash: string, data: TagsListData): void {
  for (const id of ingestFetchedTags(db.tags, queryHash, data)) removeTagCount(db.counts, id);
  writeCounts(
    db.counts,
    [
      ...data.items.map((tag) => ({ list: { tagId: tag.id }, unread: tag.unreadCount })),
      { list: { uncategorized: true }, unread: data.uncategorized.unreadCount },
    ],
    data.asOf
  );
}

function ingestSubscriptionPages(
  db: LocalDb,
  query: Query,
  data: SubscriptionPages,
  mode: "replace" | "append"
): void {
  // The earlier pages are older than this fetch: don't write them again.
  const pages = mode === "append" ? data.pages.slice(-1) : data.pages;
  const saved = pages.at(-1)?.savedSubscriptionId;
  if (saved !== undefined) setSavedSubscriptionId(db, saved);
  ingestFetchedSubscriptions(
    db.subscriptions,
    query.queryHash,
    pages.flatMap((page) => page.items)
  );
}

const SUBSCRIPTION_QUERIES = new Set(["subscriptions.list", "subscriptions.get"]);

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
      if (procedureOf(query) === "entries.list") removeEntryList(db.lists, inputOf(query));
      return;
    }
    if (event.type === "added") {
      ingestQuery(db, query, "replace");
    } else if (
      event.type === "updated" &&
      event.action.type === "fetch" &&
      SUBSCRIPTION_QUERIES.has(procedureOf(query) ?? "")
    ) {
      markFetchStarted(db.subscriptions, query.queryHash);
    } else if (
      event.type === "updated" &&
      event.action.type === "fetch" &&
      procedureOf(query) === "tags.list"
    ) {
      markFetchStarted(db.tags, query.queryHash);
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

/**
 * Inserts an entry into the loaded lists it belongs in, judged by `entry`'s
 * fields and memberships (`subscriptionIds`). Tag/uncategorized membership
 * comes from the stored subscriptions among them, and Saved from the saved
 * subscription's id; lists the client can't place it in that way pick it up
 * on their next refresh.
 */
export function insertEntryIntoLists(db: LocalDb, entry: EntryRow): void {
  insertIntoMatchingLists(
    db.lists,
    entry,
    entryMembershipScope(entry.subscriptionIds, db.saved.id, (id) =>
      db.subscriptions.rows.getSynced(id)?.tags.map((tag) => tag.id)
    )
  );
}

/** Stores a server-provided entry and inserts it into the lists it now belongs in. */
export function addServerEntryToLists(db: LocalDb, entry: EntryRow): void {
  upsertServerEntries(db.entries, [entry]);
  insertEntryIntoLists(db, db.entries.getSynced(entry.id) ?? entry);
}

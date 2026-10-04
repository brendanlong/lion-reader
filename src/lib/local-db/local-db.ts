/**
 * The client-side normalized store (TanStack DB) for entries, entry list
 * membership, and subscriptions. React Query remains the network layer:
 * `entries.*` and `subscriptions.list/get` results are ingested from the query
 * cache as they land (a QueryCache subscription, so SSR-hydrated, prefetched
 * and fetched data all take the same path), and components render from the
 * store.
 *
 * One store per QueryClient, never module-global: on the server each request
 * has its own QueryClient, and a shared store would leak one user's entries
 * into another's render.
 */

import type { Query, QueryClient } from "@tanstack/react-query";
import { BasicIndex } from "@tanstack/db";
import {
  toEntryRow,
  upsertServerEntries,
  type EntryRow,
  type EntryStore,
  type StoredEntryRow,
} from "./entries";
import {
  ingestEntryListPages,
  insertIntoMatchingLists,
  markEntryListFetchStarted,
  removeEntryList,
  type EntryListMeta,
  type EntryLists,
  type EntryTagScope,
  type ListEntryRow,
} from "./entry-lists";
import { createSyncedCollection } from "./synced-collection";
import {
  ingestFetchedSubscriptions,
  markSubscriptionFetchStarted,
  settleUnreadOnlySection,
  sidebarSectionOf,
  type SubscriptionListInput,
  type SubscriptionPages,
  type SubscriptionRow,
  type SubscriptionStore,
} from "./subscriptions";

export interface LocalDb {
  entries: EntryStore;
  lists: EntryLists;
  subscriptions: SubscriptionStore;
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
    rows: createSyncedCollection<SubscriptionRow>({
      id: `subscriptions-${dbId}`,
      getKey: (row) => row.id,
    }),
    versions: new Map(),
    fetchStartedAt: new Map(),
    fullFetchStartedAt: new Map(),
    clock: { now: 0 },
  };
  return { entries, lists: { rows, meta: new Map() }, subscriptions };
}

function procedureOf(query: Query): string | undefined {
  const path = query.queryKey[0];
  return Array.isArray(path) ? path.join(".") : undefined;
}

function inputOf(query: Query): Record<string, unknown> {
  const meta = query.queryKey[1] as { input?: Record<string, unknown> } | undefined;
  return meta?.input ?? {};
}

/**
 * `append`: the data's last page was just fetched and the rest is unchanged.
 * `fetched`: the data comes from a fetch (not a manual write or hydration),
 * so what it leaves out, the server no longer has.
 */
function ingestQuery(db: LocalDb, query: Query, mode: "replace" | "append", fetched = false): void {
  const data = query.state.data;
  if (!data) return;
  switch (procedureOf(query)) {
    case "entries.list":
      ingestListData(db, inputOf(query), data as EntriesListData, mode);
      break;
    case "entries.get":
      upsertServerEntries(db.entries, [toEntryRow((data as { entry: EntryRow }).entry)]);
      break;
    case "subscriptions.list": {
      // Infinite (the sidebar, the collection picker) or a single page.
      const list = data as SubscriptionPages | SubscriptionPages["pages"][number];
      const pages = "pages" in list ? list : { pages: [list] };
      ingestSubscriptionPages(db, query, pages, mode, fetched);
      break;
    }
    case "subscriptions.get":
      ingestFetchedSubscriptions(db.subscriptions, query.queryHash, [data as SubscriptionRow]);
      break;
  }
}

function ingestSubscriptionPages(
  db: LocalDb,
  query: Query,
  data: SubscriptionPages,
  mode: "replace" | "append",
  fetched: boolean
): void {
  const input = inputOf(query) as SubscriptionListInput;
  // The earlier pages are older than this fetch: don't write them again.
  const pages = mode === "append" ? data.pages.slice(-1) : data.pages;
  ingestFetchedSubscriptions(
    db.subscriptions,
    query.queryHash,
    pages.flatMap((page) => page.items)
  );
  const section = sidebarSectionOf(input);
  if (section && input.unreadOnly && fetched) {
    settleUnreadOnlySection(db.subscriptions, query.queryHash, section, data);
  }
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
      markSubscriptionFetchStarted(
        db.subscriptions,
        query.queryHash,
        !event.action.meta?.fetchMore
      );
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
      ingestQuery(db, query, isNextPage ? "append" : "replace", !event.action.manual);
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
  const subscription = getLocalDb(queryClient).subscriptions.rows.getSynced(entry.subscriptionId);
  if (!subscription) return undefined;
  return {
    tagIds: new Set(subscription.tags.map((tag) => tag.id)),
    uncategorized: subscription.tags.length === 0,
  };
}

/**
 * Inserts an entry into the loaded lists it belongs in, judged by `entry`'s
 * fields. Tag/uncategorized membership comes from the stored subscription;
 * when that isn't stored, those lists are skipped and pick the entry up on
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

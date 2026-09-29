/**
 * @vitest-environment jsdom
 */

/**
 * Tests for local persistence of the entry store: what a previous session
 * stored is restored into the store (without overriding this session's
 * data), later writes are mirrored to IndexedDB, old lists are evicted, and
 * databases are deleted when asked. Runs against fake-indexeddb, a complete
 * in-memory implementation of the IndexedDB API.
 */

import "fake-indexeddb/auto";
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { act, cleanup, waitFor } from "@testing-library/react";
import type { QueryClient } from "@tanstack/react-query";
import { useEntryListEntries } from "@/lib/hooks/useLocalEntries";
import { attachLocalPersistence, getLocalDb } from "@/lib/local-db/local-db";
import { entryListKey, listEntryKey, type ListEntryRow } from "@/lib/local-db/entry-lists";
import { setServerEntryState, type EntryRow } from "@/lib/local-db/entries";
import {
  deleteLocalPersistence,
  openLocalPersistence,
  type ListFetch,
  type LocalPersistence,
} from "@/lib/local-db/persistence";
import { renderHookWithTrpc } from "../../../utils/component-test-helpers";

const ALL = { unreadOnly: true, sortOrder: "newest", limit: 10 } as const;
const STARRED = { ...ALL, starredOnly: true } as const;
const DAY = 24 * 60 * 60 * 1000;

function makeEntry(id: string, publishedAt: string, overrides: Partial<EntryRow> = {}): EntryRow {
  return {
    id,
    feedId: "feed-1",
    subscriptionId: "sub-1",
    type: "web",
    url: null,
    title: id,
    author: null,
    summary: null,
    publishedAt: new Date(publishedAt),
    fetchedAt: new Date(publishedAt),
    updatedAt: new Date("2024-07-01T00:00:00Z"),
    read: false,
    starred: false,
    feedTitle: null,
    siteName: null,
    ...overrides,
  };
}

function listRow(input: object, entry: EntryRow): ListEntryRow {
  const listKey = entryListKey(input);
  return {
    key: listEntryKey(listKey, entry.id),
    listKey,
    entryId: entry.id,
    order: -(entry.publishedAt ?? entry.fetchedAt).getTime(),
  };
}

/** Writes a previous session's state straight into the user's database. */
async function storePreviousSession(
  userId: string,
  state: { entries: EntryRow[]; rows: ListEntryRow[]; fetches: ListFetch[] }
): Promise<void> {
  const persistence = await openLocalPersistence(userId);
  persistence.put("entries", state.entries);
  persistence.put("listRows", state.rows);
  persistence.put("listFetches", state.fetches);
  // Writes are fire-and-forget; a read queued after them sees them.
  await persistence.loadAll("listFetches");
}

function seedList(queryClient: QueryClient, input: object, items: EntryRow[]): void {
  queryClient.setQueryData([["entries", "list"], { input, type: "infinite" }], {
    pages: [{ items, nextCursor: undefined }],
    pageParams: [undefined],
  });
}

function renderLists() {
  const rendered = renderHookWithTrpc(() => ({
    all: useEntryListEntries(ALL),
    starred: useEntryListEntries(STARRED),
  }));
  const db = getLocalDb(rendered.queryClient);
  const attach = async (persistence: LocalPersistence) => {
    await act(() => attachLocalPersistence(db, persistence));
  };
  return { ...rendered, db, attach };
}

beforeEach(async () => {
  await deleteLocalPersistence();
});

afterEach(() => {
  cleanup();
});

describe("attachLocalPersistence", () => {
  it("restores a previous session's lists before anything is fetched", async () => {
    const a = makeEntry("a", "2024-06-01");
    const b = makeEntry("b", "2024-06-02");
    await storePreviousSession("user-1", {
      entries: [a, b],
      rows: [listRow(ALL, a), listRow(ALL, b)],
      fetches: [{ listKey: entryListKey(ALL), fetchedAt: Date.now() }],
    });

    const { result, attach } = renderLists();
    await attach(await openLocalPersistence("user-1"));

    await waitFor(() => expect(result.current.all.map((e) => e.id)).toEqual(["b", "a"]));
  });

  it("keeps this session's data over what was stored", async () => {
    const staleA = makeEntry("a", "2024-06-01", { title: "stale" });
    const gone = makeEntry("gone", "2024-06-03");
    await storePreviousSession("user-1", {
      entries: [staleA, gone],
      rows: [listRow(ALL, staleA), listRow(ALL, gone)],
      fetches: [{ listKey: entryListKey(ALL), fetchedAt: Date.now() }],
    });

    const { result, queryClient, attach } = renderLists();
    // Fetched this session before persistence attached: newer entry, and a
    // list that no longer contains "gone".
    act(() =>
      seedList(queryClient, ALL, [
        makeEntry("a", "2024-06-01", { title: "fresh", updatedAt: new Date("2024-08-01") }),
      ])
    );
    await attach(await openLocalPersistence("user-1"));

    await waitFor(() =>
      expect(result.current.all.map((e) => [e.id, e.title])).toEqual([["a", "fresh"]])
    );
  });

  it("mirrors later writes, so the next session restores them", async () => {
    const { queryClient, db, attach } = renderLists();
    await attach(await openLocalPersistence("user-1"));
    act(() => seedList(queryClient, STARRED, [makeEntry("s", "2024-06-01", { starred: true })]));
    act(() =>
      setServerEntryState(db.entries, "s", {
        read: true,
        starred: true,
        updatedAt: new Date("2024-09-01"),
      })
    );
    cleanup();

    const next = renderLists();
    await next.attach(await openLocalPersistence("user-1"));

    await waitFor(() =>
      expect(next.result.current.starred).toMatchObject([{ id: "s", read: true }])
    );
  });

  it("evicts lists not fetched within the retention window, with entries only they referenced", async () => {
    const kept = makeEntry("kept", "2024-06-01");
    const old = makeEntry("old", "2024-06-02", { starred: true });
    await storePreviousSession("user-1", {
      entries: [kept, old],
      rows: [listRow(ALL, kept), listRow(STARRED, old)],
      fetches: [
        { listKey: entryListKey(ALL), fetchedAt: Date.now() - DAY },
        { listKey: entryListKey(STARRED), fetchedAt: Date.now() - 15 * DAY },
      ],
    });

    const { result, db, attach } = renderLists();
    const persistence = await openLocalPersistence("user-1");
    await attach(persistence);

    await waitFor(() => expect(result.current.all.map((e) => e.id)).toEqual(["kept"]));
    expect(result.current.starred).toEqual([]);
    expect(db.entries.getSynced("old")).toBeUndefined();
    const storedIds = (await persistence.loadAll<EntryRow>("entries")).map((e) => e.id);
    expect(storedIds).toEqual(["kept"]);
  });

  it("a restored list's refetch drops what the server no longer returns, on disk too", async () => {
    const a = makeEntry("a", "2024-06-01");
    const gone = makeEntry("gone", "2024-06-02");
    await storePreviousSession("user-1", {
      entries: [a, gone],
      rows: [listRow(ALL, a), listRow(ALL, gone)],
      fetches: [{ listKey: entryListKey(ALL), fetchedAt: Date.now() }],
    });

    const { result, queryClient, attach } = renderLists();
    const persistence = await openLocalPersistence("user-1");
    await attach(persistence);
    await waitFor(() => expect(result.current.all.map((e) => e.id)).toEqual(["gone", "a"]));

    act(() => seedList(queryClient, ALL, [a]));

    await waitFor(() => expect(result.current.all.map((e) => e.id)).toEqual(["a"]));
    const storedRows = await persistence.loadAll<ListEntryRow>("listRows");
    expect(storedRows.map((row) => row.entryId)).toEqual(["a"]);
  });

  it("does not persist search results", async () => {
    const search = { ...ALL, unreadOnly: false, query: "secret" };
    const { queryClient, attach } = renderLists();
    const persistence = await openLocalPersistence("user-1");
    await attach(persistence);

    act(() => seedList(queryClient, search, [makeEntry("hit", "2024-06-01")]));

    expect(await persistence.loadAll("listRows")).toEqual([]);
    expect(await persistence.loadAll("listFetches")).toEqual([]);
  });

  it("keeps a restored list's rows when its query is garbage-collected", async () => {
    const { result, queryClient, attach } = renderLists();
    await attach(await openLocalPersistence("user-1"));
    act(() => seedList(queryClient, ALL, [makeEntry("a", "2024-06-01")]));
    act(() => queryClient.removeQueries({ queryKey: [["entries", "list"]] }));

    await act(async () => {});
    expect(result.current.all.map((e) => e.id)).toEqual(["a"]);
  });
});

describe("databases", () => {
  it("opening one user's database deletes other users'", async () => {
    await storePreviousSession("user-1", { entries: [], rows: [], fetches: [] });
    await openLocalPersistence("user-2");

    const names = (await indexedDB.databases()).map((d) => d.name);
    expect(names).toEqual(["lion-reader-local-user-2"]);
  });

  it("deleteLocalPersistence deletes every local database", async () => {
    await openLocalPersistence("user-1");
    await deleteLocalPersistence();

    expect(await indexedDB.databases()).toEqual([]);
  });
});

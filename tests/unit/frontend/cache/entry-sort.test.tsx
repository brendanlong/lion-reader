/**
 * @vitest-environment jsdom
 */

/**
 * Score and position lists on the client (#2064): live inserts land where the
 * server would list them, entries without a value after the rest, and an
 * `entry_state_changed` carrying a score or position offers the sort in the
 * lists it reaches.
 */

import { describe, it, expect, afterEach } from "vitest";
import { act, cleanup, waitFor } from "@testing-library/react";
import type { QueryClient } from "@tanstack/react-query";
import { useEntryListEntries, useListSortable } from "@/lib/hooks/useLocalEntries";
import { handleSyncEvent } from "@/lib/cache/event-handlers";
import type { EntryRow } from "@/lib/local-db/entries";
import { getLocalDb, insertEntryIntoLists } from "@/lib/local-db/local-db";
import { upsertServerEntries } from "@/lib/local-db/entries";
import { renderHookWithTrpc } from "../../../utils/component-test-helpers";
import { createCounts, createRealTrpcUtils } from "../../../utils/cache-test-helpers";

afterEach(() => {
  cleanup();
});

const COLLECTION = "collection-1";

function makeEntry(id: string, publishedAt: string, overrides: Partial<EntryRow> = {}): EntryRow {
  return {
    id,
    subscriptionId: "sub-1",
    subscriptionIds: ["sub-1", COLLECTION],
    positions: {},
    score: null,
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
    feedTitle: "Feed One",
    siteName: null,
    ...overrides,
  };
}

type Sortable = { score: boolean; position: boolean };

function seedList(
  queryClient: QueryClient,
  input: object,
  items: EntryRow[],
  sortable: Sortable = { score: true, position: true }
): void {
  queryClient.setQueryData([["entries", "list"], { input, type: "infinite" }], {
    pages: [{ items, sortable }],
    pageParams: [undefined],
  });
}

function renderList(input: object) {
  const rendered = renderHookWithTrpc(() => ({
    entries: useEntryListEntries(input, null),
    sortable: useListSortable(input),
  }));
  const ids = () => rendered.result.current.entries.map((entry) => entry.id);
  const insert = (entry: EntryRow) =>
    act(() => {
      const db = getLocalDb(rendered.queryClient);
      upsertServerEntries(db.entries, [entry]);
      insertEntryIntoLists(db, entry);
    });
  return { ...rendered, ids, insert };
}

describe("live inserts into ranked lists", () => {
  it("places a scored entry among the scored and an unscored one among the rest", async () => {
    const input = { sortBy: "score", sortOrder: "highest", limit: 10 };
    const { queryClient, ids, insert } = renderList(input);
    act(() =>
      seedList(queryClient, input, [
        makeEntry("nine", "2024-06-01", { score: 9 }),
        makeEntry("five", "2024-06-05", { score: 5 }),
        makeEntry("newer", "2024-06-04"),
        makeEntry("older", "2024-06-02"),
      ])
    );
    await waitFor(() => expect(ids()).toEqual(["nine", "five", "newer", "older"]));

    insert(makeEntry("seven", "2024-06-03", { score: 7 }));
    insert(makeEntry("tie", "2024-06-06", { score: 5 }));
    insert(makeEntry("middle", "2024-06-03"));
    await waitFor(() =>
      expect(ids()).toEqual(["nine", "seven", "tie", "five", "newer", "middle", "older"])
    );
  });

  it("lists lowest first with ties oldest first, and the unscored still newest first", async () => {
    const input = { sortBy: "score", sortOrder: "lowest", limit: 10 };
    const { queryClient, ids, insert } = renderList(input);
    act(() =>
      seedList(queryClient, input, [
        makeEntry("five", "2024-06-05", { score: 5 }),
        makeEntry("older", "2024-06-02"),
      ])
    );
    insert(makeEntry("tie", "2024-06-06", { score: 5 }));
    insert(makeEntry("earlyTie", "2024-06-01", { score: 5 }));
    insert(makeEntry("newer", "2024-06-04"));
    await waitFor(() => expect(ids()).toEqual(["earlyTie", "five", "tie", "newer", "older"]));
  });

  it("orders a collection by the entry's position in it", async () => {
    const input = { subscriptionId: COLLECTION, sortBy: "position", sortOrder: "first", limit: 10 };
    const { queryClient, ids, insert } = renderList(input);
    act(() =>
      seedList(queryClient, input, [
        makeEntry("one", "2024-06-03", { positions: { [COLLECTION]: 1 } }),
        makeEntry("two", "2024-06-01", { positions: { [COLLECTION]: 2, other: 0 } }),
        makeEntry("loose", "2024-06-02"),
      ])
    );
    // Its position in another collection doesn't count here.
    insert(makeEntry("between", "2024-06-04", { positions: { [COLLECTION]: 1.5, other: 9 } }));
    insert(makeEntry("newLoose", "2024-06-05", { positions: { other: 0 } }));
    await waitFor(() => expect(ids()).toEqual(["one", "between", "two", "newLoose", "loose"]));
  });

  it("skips an entry that sorts past a partially loaded list", async () => {
    const input = { sortBy: "score", sortOrder: "highest", limit: 10 };
    const { queryClient, ids, insert } = renderList(input);
    act(() =>
      queryClient.setQueryData([["entries", "list"], { input, type: "infinite" }], {
        pages: [{ items: [makeEntry("nine", "2024-06-01", { score: 9 })], nextCursor: "next" }],
        pageParams: [undefined],
      })
    );
    insert(makeEntry("unscored", "2024-06-09"));
    insert(makeEntry("ten", "2024-06-01", { score: 10 }));
    await waitFor(() => expect(ids()).toEqual(["ten", "nine"]));
  });
});

describe("sortable", () => {
  const COUNTS = createCounts({ all: { unread: 1 } });

  function stateChanged(
    entry: EntryRow,
    change: { score?: number | null; positions?: Record<string, number> }
  ) {
    return {
      type: "entry_state_changed" as const,
      entryId: entry.id,
      read: entry.read,
      starred: entry.starred,
      counts: COUNTS,
      timestamp: "2024-07-02T00:00:00Z",
      updatedAt: "2024-07-02T00:00:00Z",
      subscriptionIds: entry.subscriptionIds,
      ...change,
    };
  }

  it("is the first page's, then gains a sort when an entry in the list gets a value", async () => {
    const input = { subscriptionId: COLLECTION, unreadOnly: true, limit: 10 };
    const entry = makeEntry("a", "2024-06-01");
    const { queryClient, result } = renderList(input);
    const utils = createRealTrpcUtils(queryClient);
    act(() => seedList(queryClient, input, [entry], { score: false, position: false }));
    await waitFor(() => expect(result.current.sortable).toMatchObject({ score: false }));

    act(() => handleSyncEvent(utils, queryClient, stateChanged(entry, { score: 3 })));
    await waitFor(() =>
      expect(result.current.sortable).toMatchObject({ score: true, position: false })
    );

    act(() =>
      handleSyncEvent(utils, queryClient, stateChanged(entry, { positions: { [COLLECTION]: 1 } }))
    );
    await waitFor(() => expect(result.current.sortable).toMatchObject({ position: true }));
  });

  it("isn't offered by an entry the list's filters leave out, or another collection's position", async () => {
    const input = { subscriptionId: COLLECTION, unreadOnly: true, limit: 10 };
    const read = makeEntry("read", "2024-06-01", { read: true });
    const { queryClient, result } = renderList(input);
    const utils = createRealTrpcUtils(queryClient);
    act(() => seedList(queryClient, input, [], { score: false, position: false }));
    await waitFor(() => expect(result.current.sortable).toBeDefined());

    act(() => {
      upsertServerEntries(getLocalDb(queryClient).entries, [read]);
      handleSyncEvent(utils, queryClient, stateChanged(read, { score: 3 }));
      handleSyncEvent(
        utils,
        queryClient,
        stateChanged(makeEntry("elsewhere", "2024-06-01"), { positions: { other: 1 } })
      );
    });
    expect(result.current.sortable).toMatchObject({ score: false, position: false });
  });
});

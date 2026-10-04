/**
 * @vitest-environment jsdom
 */

/**
 * Tests for collection membership changes (#1806) reaching the client: the
 * collection_entries_changed event updates the collection's loaded lists, the
 * entry's cached membership and the counts, without touching other lists.
 */

import { describe, it, expect, afterEach } from "vitest";
import { act, cleanup, waitFor } from "@testing-library/react";
import type { QueryClient } from "@tanstack/react-query";
import { useEntryListEntries } from "@/lib/hooks/useLocalEntries";
import { handleSyncEvent } from "@/lib/cache/event-handlers";
import type { EntryRow } from "@/lib/local-db/entries";
import { renderHookWithTrpc } from "../../../utils/component-test-helpers";
import { createRealTrpcUtils } from "../../../utils/cache-test-helpers";

afterEach(() => {
  cleanup();
});

const COLLECTION = "collection-1";
const FEED_LIST = { subscriptionId: "sub-1", sortOrder: "newest" as const, limit: 10 };
const COLLECTION_LIST = { subscriptionId: COLLECTION, sortOrder: "newest" as const, limit: 10 };
const UNREAD_COLLECTION_LIST = { ...COLLECTION_LIST, unreadOnly: true };

function makeEntry(id: string, publishedAt: string, overrides: Partial<EntryRow> = {}): EntryRow {
  return {
    id,
    feedId: "feed-1",
    subscriptionId: "sub-1",
    type: "web",
    url: `https://example.com/${id}`,
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

function seedList(queryClient: QueryClient, input: object, items: EntryRow[]): void {
  queryClient.setQueryData([["entries", "list"], { input, type: "infinite" }], {
    pages: [{ items }],
    pageParams: [undefined],
  });
}

const COUNTS = {
  all: { unread: 3 },
  starred: { unread: 0 },
  saved: { unread: 0 },
  subscriptions: [{ id: COLLECTION, unread: 1 }],
  tags: [],
};

function setup(entries: { feed: EntryRow[]; collection: EntryRow[] }) {
  const rendered = renderHookWithTrpc(() => ({
    feed: useEntryListEntries(FEED_LIST),
    collection: useEntryListEntries(COLLECTION_LIST),
    unreadCollection: useEntryListEntries(UNREAD_COLLECTION_LIST),
  }));
  const { queryClient } = rendered;
  const utils = createRealTrpcUtils(queryClient);
  act(() => {
    seedList(queryClient, FEED_LIST, entries.feed);
    seedList(queryClient, COLLECTION_LIST, entries.collection);
    seedList(queryClient, UNREAD_COLLECTION_LIST, entries.collection);
  });
  const ids = (list: "feed" | "collection" | "unreadCollection") =>
    rendered.result.current[list].map((entry) => entry.id);
  const changeMembership = (entryIds: string[], added: boolean) =>
    act(() =>
      handleSyncEvent(utils, queryClient, {
        type: "collection_entries_changed",
        subscriptionId: COLLECTION,
        entryIds,
        added,
        counts: COUNTS,
        timestamp: "2024-07-02T00:00:00Z",
        updatedAt: "2024-07-02T00:00:00Z",
      })
    );
  return { utils, queryClient, ids, changeMembership };
}

describe("collection_entries_changed", () => {
  it("adds a stored entry to the collection's lists in sorted position", async () => {
    const newer = makeEntry("newer", "2024-06-03");
    const added = makeEntry("added", "2024-06-02", { read: true });
    const older = makeEntry("older", "2024-06-01");
    const { ids, changeMembership } = setup({
      feed: [newer, added, older],
      collection: [newer, older],
    });
    await waitFor(() => expect(ids("collection")).toEqual(["newer", "older"]));

    changeMembership(["added"], true);

    await waitFor(() => expect(ids("collection")).toEqual(["newer", "added", "older"]));
    // Read, so it doesn't belong in the unread-only view of the collection.
    expect(ids("unreadCollection")).toEqual(["newer", "older"]);
  });

  it("keeps a removed entry in loaded lists until they refresh", async () => {
    // The reader keeps its place (j/k from the open entry) after taking the
    // open entry out of the collection being viewed.
    const entry = makeEntry("a", "2024-06-01");
    const { ids, changeMembership } = setup({ feed: [entry], collection: [entry] });
    await waitFor(() => expect(ids("collection")).toEqual(["a"]));

    changeMembership(["a"], false);

    expect(ids("collection")).toEqual(["a"]);
  });

  it("drops a deleted collection from every cached membership", () => {
    const { utils, queryClient } = setup({ feed: [], collection: [] });
    act(() => {
      utils.collections.listForEntry.setData({ entryId: "a" }, { collectionIds: [COLLECTION] });
      utils.collections.listForEntry.setData(
        { entryId: "b" },
        { collectionIds: [COLLECTION, "other"] }
      );
    });

    act(() =>
      handleSyncEvent(utils, queryClient, {
        type: "subscription_deleted",
        subscriptionId: COLLECTION,
        timestamp: "2024-07-02T00:00:00Z",
        updatedAt: "2024-07-02T00:00:00Z",
      })
    );

    expect(utils.collections.listForEntry.getData({ entryId: "a" })).toEqual({
      collectionIds: [],
    });
    expect(utils.collections.listForEntry.getData({ entryId: "b" })).toEqual({
      collectionIds: ["other"],
    });
  });

  it("updates the entry's cached membership and the counts", () => {
    const entry = makeEntry("a", "2024-06-01");
    const { utils, changeMembership } = setup({ feed: [entry], collection: [] });
    act(() => utils.collections.listForEntry.setData({ entryId: "a" }, { collectionIds: [] }));

    changeMembership(["a"], true);
    expect(utils.collections.listForEntry.getData({ entryId: "a" })).toEqual({
      collectionIds: [COLLECTION],
    });
    expect(utils.entries.count.getData({})).toEqual({ unread: 3 });

    // Re-delivery (mutation response, then the SSE event) is a no-op.
    changeMembership(["a"], true);
    expect(utils.collections.listForEntry.getData({ entryId: "a" })).toEqual({
      collectionIds: [COLLECTION],
    });
  });
});

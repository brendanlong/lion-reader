/**
 * @vitest-environment jsdom
 */

/**
 * Tests for collection membership changes (#1806) reaching the client: the
 * collection_entries_changed event updates the stored entry's memberships, the
 * loaded lists of the collection and the tag lists it joined or left, and the
 * counts.
 */

import { describe, it, expect, afterEach } from "vitest";
import { act, cleanup, waitFor } from "@testing-library/react";
import type { QueryClient } from "@tanstack/react-query";
import { useEntryListEntries } from "@/lib/hooks/useLocalEntries";
import { handleSyncEvent } from "@/lib/cache/event-handlers";
import { applyCollectionEntriesChange, applyNewEntry } from "@/lib/cache/operations";
import { trpc } from "@/lib/trpc/client";
import type { EntryRow } from "@/lib/local-db/entries";
import { getLocalDb } from "@/lib/local-db/local-db";
import { renderHookWithTrpc } from "../../../utils/component-test-helpers";
import { createCounts, createRealTrpcUtils, storedCount } from "../../../utils/cache-test-helpers";

function storedEntry(queryClient: QueryClient, id: string): EntryRow | undefined {
  return getLocalDb(queryClient).entries.getSynced(id);
}

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
    subscriptionId: "sub-1",
    subscriptionIds: ["sub-1"],
    positions: {},
    tagLists: { tagIds: [], uncategorized: false },
    score: null,
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

/** In sub-1 alone, which is untagged. */
const tagListsOf = (entryIds: string[]) =>
  entryIds.map((entryId) => ({ entryId, tagIds: [], uncategorized: true }));

/** Later than every seeded entry's state. */
const CHANGED_AT = new Date("2024-07-02T00:00:00Z");

const COUNTS = createCounts({
  all: { unread: 3 },
  subscriptions: [{ id: COLLECTION, unread: 1 }],
});

function setup(entries: { feed: EntryRow[]; collection: EntryRow[] }) {
  let openEntryId: string | null = null;
  const rendered = renderHookWithTrpc(() => ({
    feed: useEntryListEntries(FEED_LIST, openEntryId),
    collection: useEntryListEntries(COLLECTION_LIST, openEntryId),
    unreadCollection: useEntryListEntries(UNREAD_COLLECTION_LIST, openEntryId),
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
        tagLists: tagListsOf(entryIds),
        timestamp: "2024-07-02T00:00:00Z",
        updatedAt: "2024-07-02T00:00:00Z",
      })
    );
  const openEntry = (id: string | null) => {
    openEntryId = id;
    rendered.rerender();
  };
  return { utils, queryClient, ids, changeMembership, openEntry };
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

  it("moves the entry into and out of the tag lists the server says it joined or left", async () => {
    const list = (filter: object) => ({ ...filter, sortOrder: "newest" as const, limit: 10 });
    const COLLECTION_TAG = list({ tagId: "tag-2" });
    const FEED_TAG = list({ tagId: "tag-1" });
    const UNCATEGORIZED = list({ uncategorized: true });
    const rendered = renderHookWithTrpc(() => ({
      collectionTag: useEntryListEntries(COLLECTION_TAG, null),
      feedTag: useEntryListEntries(FEED_TAG, null),
      uncategorized: useEntryListEntries(UNCATEGORIZED, null),
    }));
    const { queryClient } = rendered;
    const utils = createRealTrpcUtils(queryClient);
    const entry = makeEntry("a", "2024-06-01");
    act(() => {
      seedList(queryClient, FEED_LIST, [entry]);
      seedList(queryClient, COLLECTION_TAG, []);
      seedList(queryClient, FEED_TAG, [entry]);
      seedList(queryClient, UNCATEGORIZED, []);
    });
    // The client hasn't loaded the collection, so only the server knows its tags.
    let changedAt = entry.updatedAt.getTime();
    const change = (added: boolean, tagIds: string[], uncategorized: boolean) =>
      act(() =>
        applyCollectionEntriesChange(utils, queryClient, {
          subscriptionId: COLLECTION,
          added,
          tagLists: [{ entryId: "a", tagIds, uncategorized }],
          updatedAt: new Date(++changedAt),
        })
      );
    const ids = () =>
      Object.fromEntries(
        Object.entries(rendered.result.current).map(([key, rows]) => [key, rows.map((e) => e.id)])
      );
    const stored = () => getLocalDb(queryClient).entries.getSynced("a")?.subscriptionIds;

    change(true, ["tag-1", "tag-2"], true);
    await waitFor(() =>
      expect(ids()).toEqual({ collectionTag: ["a"], feedTag: ["a"], uncategorized: ["a"] })
    );
    expect(stored()).toEqual(["sub-1", COLLECTION]);

    change(false, ["tag-1"], false);
    await waitFor(() =>
      expect(ids()).toEqual({ collectionTag: [], feedTag: ["a"], uncategorized: [] })
    );
    expect(stored()).toEqual(["sub-1"]);

    change(true, ["tag-1", "tag-2"], true);
    await waitFor(() =>
      expect(ids()).toEqual({ collectionTag: ["a"], feedTag: ["a"], uncategorized: ["a"] })
    );
  });

  it("hides a removed entry from the collection's lists once it's no longer open", async () => {
    const entries = [
      makeEntry("c", "2024-06-03"),
      makeEntry("b", "2024-06-02"),
      makeEntry("a", "2024-06-01"),
    ];
    const { ids, changeMembership, openEntry } = setup({ feed: entries, collection: entries });
    await waitFor(() => expect(ids("collection")).toEqual(["c", "b", "a"]));
    openEntry("b");

    changeMembership(["b"], false);
    // Still listed while open, so j/k from it keeps its place.
    expect(ids("collection")).toEqual(["c", "b", "a"]);

    openEntry("a");
    await waitFor(() => expect(ids("collection")).toEqual(["c", "a"]));
    expect(ids("unreadCollection")).toEqual(["c", "a"]);
    expect(ids("feed")).toEqual(["c", "b", "a"]);
  });

  it("shows a removed entry again when it's re-added", async () => {
    const entry = makeEntry("a", "2024-06-01");
    const { ids, changeMembership } = setup({ feed: [entry], collection: [entry] });
    await waitFor(() => expect(ids("collection")).toEqual(["a"]));
    changeMembership(["a"], false);
    await waitFor(() => expect(ids("collection")).toEqual([]));

    changeMembership(["a"], true);

    await waitFor(() => expect(ids("collection")).toEqual(["a"]));
  });

  it("keeps an entry removed when a fetch that started before the removal lands", async () => {
    const entry = makeEntry("a", "2024-06-01");
    let release: (() => void) | undefined;
    let calls = 0;
    const rendered = renderHookWithTrpc(
      () => ({
        query: trpc.entries.list.useInfiniteQuery(COLLECTION_LIST, {
          getNextPageParam: (page) => page.nextCursor,
        }),
        entries: useEntryListEntries(COLLECTION_LIST, null),
      }),
      {
        handlers: {
          // The refetch's snapshot predates the removal.
          "entries.list": () => {
            calls++;
            if (calls === 1) return { items: [entry] };
            return new Promise((resolve) => {
              release = () => resolve({ items: [entry] });
            });
          },
        },
      }
    );
    const { queryClient } = rendered;
    const ids = () => rendered.result.current.entries.map((e) => e.id);
    await waitFor(() => expect(ids()).toEqual(["a"]));

    let refetched: Promise<unknown> | undefined;
    act(() => {
      refetched = rendered.result.current.query.refetch();
    });
    await waitFor(() => expect(release).toBeDefined());
    act(() =>
      applyCollectionEntriesChange(createRealTrpcUtils(queryClient), queryClient, {
        subscriptionId: COLLECTION,
        added: false,
        tagLists: tagListsOf(["a"]),
        updatedAt: CHANGED_AT,
      })
    );
    await act(async () => {
      release?.();
      await refetched;
    });

    expect(ids()).toEqual([]);
  });

  describe("pagination", () => {
    const first = makeEntry("first", "2024-06-02");
    const second = makeEntry("second", "2024-06-01");

    /** A two-page collection list; `pageTwo`/`refetch` control later fetches. */
    function renderPagedList(handlers: { pageTwo: () => unknown; refetch?: () => unknown }) {
      let pageOneCalls = 0;
      const rendered = renderHookWithTrpc(
        () => ({
          query: trpc.entries.list.useInfiniteQuery(COLLECTION_LIST, {
            getNextPageParam: (page) => page.nextCursor,
            retry: false,
          }),
          entries: useEntryListEntries(COLLECTION_LIST, null),
        }),
        {
          handlers: {
            "entries.list": (input) => {
              if ((input as { cursor?: string }).cursor) return handlers.pageTwo();
              pageOneCalls++;
              if (pageOneCalls > 1 && handlers.refetch) return handlers.refetch();
              return { items: [first], nextCursor: "c1" };
            },
          },
        }
      );
      const { queryClient } = rendered;
      const remove = (entryId: string) =>
        act(() =>
          applyCollectionEntriesChange(createRealTrpcUtils(queryClient), queryClient, {
            subscriptionId: COLLECTION,
            added: false,
            tagLists: tagListsOf([entryId]),
            updatedAt: CHANGED_AT,
          })
        );
      const ids = () => rendered.result.current.entries.map((e) => e.id);
      return { ...rendered, remove, ids };
    }

    it("hides an entry removed before its page loaded", async () => {
      let releasePageTwo: (() => void) | undefined;
      const { result, remove, ids } = renderPagedList({
        pageTwo: () =>
          new Promise((resolve) => {
            releasePageTwo = () => resolve({ items: [second] });
          }),
      });
      await waitFor(() => expect(ids()).toEqual(["first"]));

      let nextPage: Promise<unknown> | undefined;
      act(() => {
        nextPage = result.current.query.fetchNextPage();
      });
      await waitFor(() => expect(releasePageTwo).toBeDefined());
      remove("second");
      await act(async () => {
        releasePageTwo?.();
        await nextPage;
      });

      expect(ids()).toEqual(["first"]);
    });

    it("keeps an entry removed through a failed refetch and a next page", async () => {
      // The failed refetch's start cleared the list's record of live removals.
      const { result, remove, ids } = renderPagedList({
        pageTwo: () => ({ items: [second] }),
        refetch: () => {
          throw new Error("offline");
        },
      });
      await waitFor(() => expect(ids()).toEqual(["first"]));
      remove("first");
      await waitFor(() => expect(ids()).toEqual([]));

      await act(async () => {
        await result.current.query.refetch();
      });
      await act(async () => {
        await result.current.query.fetchNextPage();
      });

      await waitFor(() => expect(ids()).toEqual(["second"]));
    });
  });

  it("drops a deleted collection from its stored articles' memberships", () => {
    const { utils, queryClient } = setup({
      feed: [makeEntry("a", "2024-06-01", { subscriptionIds: ["sub-1", COLLECTION, "other"] })],
      collection: [],
    });

    act(() =>
      handleSyncEvent(utils, queryClient, {
        type: "subscription_deleted",
        subscriptionId: COLLECTION,
        timestamp: "2024-07-02T00:00:00Z",
        updatedAt: "2024-07-02T00:00:00Z",
      })
    );

    expect(storedEntry(queryClient, "a")?.subscriptionIds).toEqual(["sub-1", "other"]);
  });

  it("updates the entry's stored membership and the counts", () => {
    const entry = makeEntry("a", "2024-06-01");
    const { queryClient, changeMembership } = setup({ feed: [entry], collection: [] });

    changeMembership(["a"], true);
    expect(storedEntry(queryClient, "a")?.subscriptionIds).toEqual(["sub-1", COLLECTION]);
    expect(storedCount(queryClient, { all: true })).toEqual({ unread: 3 });

    // Re-delivery (mutation response, then the SSE event) is a no-op.
    changeMembership(["a"], true);
    expect(storedEntry(queryClient, "a")?.subscriptionIds).toEqual(["sub-1", COLLECTION]);
  });

  it("keeps an upload's collection when the upload's response lands after the add's event", async () => {
    const { utils, queryClient, ids, changeMembership } = setup({ feed: [], collection: [] });
    // Read at insert, before the upload was filed into the collection.
    const insertedListItem = {
      entryId: "upload",
      subscriptionId: "sub-1",
      subscriptionIds: ["sub-1"],
      tagLists: { tagIds: [], uncategorized: true },
      updatedAt: "2024-07-01T00:00:00Z",
      entry: {
        type: "web" as const,
        title: "Upload",
        author: null,
        summary: null,
        url: null,
        publishedAt: null,
        fetchedAt: "2024-07-01T00:00:00Z",
        siteName: null,
        feedTitle: "Feed One",
      },
    };
    act(() => applyNewEntry(utils, queryClient, insertedListItem, undefined));

    changeMembership(["upload"], true);
    act(() => applyNewEntry(utils, queryClient, insertedListItem, undefined));

    expect(storedEntry(queryClient, "upload")?.subscriptionIds).toEqual(["sub-1", COLLECTION]);
    await waitFor(() => expect(ids("collection")).toEqual(["upload"]));
  });

  it("ignores an add older than a removal it lost the race to", async () => {
    const entry = makeEntry("a", "2024-06-01");
    const { utils, queryClient, ids } = setup({ feed: [entry], collection: [entry] });
    await waitFor(() => expect(ids("collection")).toEqual(["a"]));
    const change = (added: boolean, updatedAt: Date) =>
      act(() =>
        applyCollectionEntriesChange(utils, queryClient, {
          subscriptionId: COLLECTION,
          added,
          tagLists: tagListsOf(["a"]),
          updatedAt,
        })
      );

    change(false, CHANGED_AT);
    change(true, new Date(CHANGED_AT.getTime() - 1));

    expect(storedEntry(queryClient, "a")?.subscriptionIds).toEqual(["sub-1"]);
    await waitFor(() => expect(ids("collection")).toEqual([]));
  });

  it("applies a change without a time (a server a release behind) without moving the state's", () => {
    const entry = makeEntry("a", "2024-06-01");
    const { utils, queryClient } = setup({ feed: [entry], collection: [] });

    act(() =>
      applyCollectionEntriesChange(utils, queryClient, {
        subscriptionId: COLLECTION,
        added: true,
        tagLists: tagListsOf(["a"]),
      })
    );

    expect(getLocalDb(queryClient).entries.getSynced("a")).toMatchObject({
      subscriptionIds: ["sub-1", COLLECTION],
      stateUpdatedAt: entry.updatedAt,
    });
  });

  it("records the position an entry joined with even when its membership is already stored", () => {
    // Fetched after the add, before its response or event.
    const entry = makeEntry("a", "2024-06-01", { subscriptionIds: ["sub-1", COLLECTION] });
    const { utils, queryClient } = setup({ feed: [entry], collection: [] });

    act(() =>
      applyCollectionEntriesChange(utils, queryClient, {
        subscriptionId: COLLECTION,
        added: true,
        tagLists: tagListsOf(["a"]),
        positions: { a: 7 },
        updatedAt: CHANGED_AT,
      })
    );

    expect(storedEntry(queryClient, "a")?.positions).toEqual({ [COLLECTION]: 7 });
  });
});

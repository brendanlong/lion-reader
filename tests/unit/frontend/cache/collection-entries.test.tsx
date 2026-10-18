/**
 * @vitest-environment jsdom
 */

/**
 * Tests for collection membership changes (#1806) reaching the client: the
 * collection_entries_changed event updates the stored entry's memberships, the
 * loaded lists of the collection (and of its tags, on an add) and the counts.
 */

import { describe, it, expect, afterEach } from "vitest";
import { act, cleanup, waitFor } from "@testing-library/react";
import type { QueryClient } from "@tanstack/react-query";
import { useEntryListEntries } from "@/lib/hooks/useLocalEntries";
import { handleSyncEvent } from "@/lib/cache/event-handlers";
import { applyCollectionEntriesChange } from "@/lib/cache/operations";
import { trpc } from "@/lib/trpc/client";
import type { EntryRow } from "@/lib/local-db/entries";
import { getLocalDb } from "@/lib/local-db/local-db";
import { writeLiveSubscriptions } from "@/lib/local-db/subscriptions";
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

  it("records the membership on the stored entry, which places it in the collection's tag lists", async () => {
    const TAG_LIST = { tagId: "tag-2", sortOrder: "newest" as const, limit: 10 };
    const rendered = renderHookWithTrpc(() => useEntryListEntries(TAG_LIST, null));
    const { queryClient } = rendered;
    const utils = createRealTrpcUtils(queryClient);
    act(() => {
      writeLiveSubscriptions(getLocalDb(queryClient).subscriptions, [
        {
          id: COLLECTION,
          type: "collection",
          url: null,
          title: "Reading",
          originalTitle: null,
          description: null,
          siteUrl: null,
          subscribedAt: new Date("2024-01-01T00:00:00Z"),
          unreadCount: 0,
          tags: [{ id: "tag-2", name: "Science", color: null }],
          fetchFullContent: false,
        },
      ]);
      seedList(queryClient, FEED_LIST, [makeEntry("a", "2024-06-01")]);
      seedList(queryClient, TAG_LIST, []);
    });
    const change = (added: boolean) =>
      act(() =>
        applyCollectionEntriesChange(utils, queryClient, {
          subscriptionId: COLLECTION,
          entryIds: ["a"],
          added,
        })
      );
    const stored = () => getLocalDb(queryClient).entries.getSynced("a")?.subscriptionIds;

    change(true);
    await waitFor(() => expect(rendered.result.current.map((e) => e.id)).toEqual(["a"]));
    expect(stored()).toEqual(["sub-1", COLLECTION]);

    change(false);
    expect(stored()).toEqual(["sub-1"]);
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
        entryIds: ["a"],
        added: false,
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
            entryIds: [entryId],
            added: false,
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
    expect(storedCount(queryClient, {})).toEqual({ unread: 3 });

    // Re-delivery (mutation response, then the SSE event) is a no-op.
    changeMembership(["a"], true);
    expect(storedEntry(queryClient, "a")?.subscriptionIds).toEqual(["sub-1", COLLECTION]);
  });
});

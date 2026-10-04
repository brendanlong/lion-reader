/**
 * @vitest-environment jsdom
 */

/**
 * Tests for entry list membership: `entries.list` results are ingested from
 * the query cache into the local store, and lists render (via
 * `useEntryListEntries`) from membership rows joined to the entry store.
 *
 * Covers ingestion (refetch replaces, next page appends), live inserts
 * (sorted position, pagination window, filter targeting, dedupe), and that
 * state changes never change membership.
 */

import { describe, it, expect, afterEach } from "vitest";
import { act, cleanup, waitFor } from "@testing-library/react";
import type { QueryClient } from "@tanstack/react-query";
import { trpc } from "@/lib/trpc/client";
import { useEntryListEntries } from "@/lib/hooks/useLocalEntries";
import { getLocalDb, insertEntryIntoLists } from "@/lib/local-db/local-db";
import { setServerEntryState, upsertServerEntries, type EntryRow } from "@/lib/local-db/entries";
import { addSubscriptionToCache } from "@/lib/cache/count-cache";
import { renderHookWithTrpc } from "../../../utils/component-test-helpers";

afterEach(() => {
  cleanup();
});

function seedSubscription(
  queryClient: QueryClient,
  id: string,
  tags: Array<{ id: string; name: string }> = []
): void {
  addSubscriptionToCache(queryClient, {
    id,
    type: "web",
    url: `https://example.com/${id}.xml`,
    title: `Feed ${id}`,
    originalTitle: `Feed ${id}`,
    description: null,
    siteUrl: null,
    subscribedAt: new Date("2024-01-01T00:00:00Z"),
    unreadCount: 0,
    tags: tags.map((tag) => ({ ...tag, color: null })),
    fetchFullContent: false,
  });
}

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

type ListInput = Record<string, unknown>;

function seedList(
  queryClient: QueryClient,
  input: ListInput,
  pages: Array<{ items: EntryRow[]; nextCursor?: string }>
): void {
  queryClient.setQueryData([["entries", "list"], { input, type: "infinite" }], {
    pages,
    pageParams: pages.map((_, i) => (i === 0 ? undefined : `cursor-${i}`)),
  });
}

/** Renders the lists and returns a reader for each list's entry ids. */
function renderLists(inputs: Record<string, ListInput>) {
  const names = Object.keys(inputs);
  const rendered = renderHookWithTrpc(() =>
    Object.fromEntries(names.map((name) => [name, useEntryListEntries(inputs[name], null)]))
  );
  const ids = (name: string) => rendered.result.current[name].map((entry) => entry.id);
  const insert = (entry: EntryRow) =>
    act(() => {
      const db = getLocalDb(rendered.queryClient);
      upsertServerEntries(db.entries, [entry]);
      insertEntryIntoLists(db, rendered.queryClient, entry);
    });
  return { ...rendered, ids, insert };
}

const ALL = { unreadOnly: true, sortOrder: "newest", limit: 10 };

describe("list ingestion", () => {
  it("renders a seeded list in server order", async () => {
    const { queryClient, ids } = renderLists({ all: ALL });
    act(() =>
      seedList(queryClient, ALL, [
        { items: [makeEntry("b", "2024-06-02"), makeEntry("a", "2024-06-01")] },
      ])
    );
    await waitFor(() => expect(ids("all")).toEqual(["b", "a"]));
  });

  it("a refetch drops entries the server no longer returns", async () => {
    const { queryClient, ids } = renderLists({ all: ALL });
    act(() =>
      seedList(queryClient, ALL, [
        { items: [makeEntry("b", "2024-06-02"), makeEntry("a", "2024-06-01")] },
      ])
    );
    act(() => seedList(queryClient, ALL, [{ items: [makeEntry("a", "2024-06-01")] }]));
    await waitFor(() => expect(ids("all")).toEqual(["a"]));
  });

  it("a next-page fetch keeps entries inserted live while it was in flight", async () => {
    const pageTwo = makeEntry("old", "2024-05-01");
    const rendered = renderHookWithTrpc(
      () => ({
        query: trpc.entries.list.useInfiniteQuery(
          { limit: 1, unreadOnly: true, sortOrder: "newest" },
          { getNextPageParam: (page) => page.nextCursor }
        ),
        entries: useEntryListEntries({ limit: 1, unreadOnly: true, sortOrder: "newest" }, null),
      }),
      {
        handlers: {
          "entries.list": (input) =>
            (input as { cursor?: string }).cursor
              ? { items: [pageTwo] }
              : { items: [makeEntry("first", "2024-06-01")], nextCursor: "c1" },
        },
      }
    );
    await waitFor(() => expect(rendered.result.current.entries).toHaveLength(1));

    act(() => {
      const db = getLocalDb(rendered.queryClient);
      const live = makeEntry("live", "2024-07-01");
      upsertServerEntries(db.entries, [live]);
      insertEntryIntoLists(db, rendered.queryClient, live);
    });
    await act(async () => {
      await rendered.result.current.query.fetchNextPage();
    });

    await waitFor(() =>
      expect(rendered.result.current.entries.map((e) => e.id)).toEqual(["live", "first", "old"])
    );
  });

  it("treats a manual cache write after a next page as the complete list", async () => {
    const input = { limit: 1, unreadOnly: true, sortOrder: "newest" } as const;
    const rendered = renderHookWithTrpc(
      () => ({
        query: trpc.entries.list.useInfiniteQuery(input, {
          getNextPageParam: (page) => page.nextCursor,
        }),
        entries: useEntryListEntries(input, null),
      }),
      {
        handlers: {
          "entries.list": (request) =>
            (request as { cursor?: string }).cursor
              ? { items: [makeEntry("old", "2024-05-01")] }
              : { items: [makeEntry("first", "2024-06-01")], nextCursor: "c1" },
        },
      }
    );
    await waitFor(() => expect(rendered.result.current.entries).toHaveLength(1));
    await act(async () => {
      await rendered.result.current.query.fetchNextPage();
    });
    await waitFor(() => expect(rendered.result.current.entries).toHaveLength(2));

    act(() => seedList(rendered.queryClient, input, [{ items: [makeEntry("c", "2024-07-01")] }]));

    await waitFor(() => expect(rendered.result.current.entries.map((e) => e.id)).toEqual(["c"]));
  });

  describe("a refetch racing a live insert", () => {
    const input = { limit: 10, unreadOnly: true, sortOrder: "newest" } as const;

    /** A list whose refetches wait until the test releases them. */
    function renderRefetchableList() {
      let releaseRefetch: (() => void) | undefined;
      let calls = 0;
      const rendered = renderHookWithTrpc(
        () => ({
          query: trpc.entries.list.useInfiniteQuery(input, {
            getNextPageParam: (page) => page.nextCursor,
          }),
          entries: useEntryListEntries(input, null),
        }),
        {
          handlers: {
            // The server never returns "live": its snapshot predates it.
            "entries.list": () => {
              calls++;
              const page = { items: [makeEntry("a", "2024-06-01")] };
              if (calls === 1) return page;
              return new Promise((resolve) => {
                releaseRefetch = () => resolve(page);
              });
            },
          },
        }
      );
      const insertLive = () =>
        act(() => {
          const db = getLocalDb(rendered.queryClient);
          const live = makeEntry("live", "2024-07-01");
          upsertServerEntries(db.entries, [live]);
          insertEntryIntoLists(db, rendered.queryClient, live);
        });
      const refetch = () => {
        let settled: Promise<unknown> | undefined;
        act(() => {
          settled = rendered.result.current.query.refetch();
        });
        return async () => {
          await waitFor(() => expect(releaseRefetch).toBeDefined());
          await act(async () => {
            releaseRefetch?.();
            await settled;
          });
        };
      };
      const ids = () => rendered.result.current.entries.map((e) => e.id);
      return { ...rendered, insertLive, refetch, ids };
    }

    it("keeps an entry inserted live after the refetch started", async () => {
      const { insertLive, refetch, ids } = renderRefetchableList();
      await waitFor(() => expect(ids()).toEqual(["a"]));

      const release = refetch();
      insertLive();
      await release();

      expect(ids()).toEqual(["live", "a"]);
    });

    it("does not keep a live insert that now sorts past the refetched window", async () => {
      // The refetch lands with newer entries and more pages, so its window no
      // longer reaches the live-inserted entry; keeping it would render it
      // after a gap of unloaded entries.
      const { queryClient, ids, insert } = renderLists({ all: ALL });
      act(() =>
        seedList(queryClient, ALL, [
          {
            items: [makeEntry("c", "2024-06-03"), makeEntry("b", "2024-06-02")],
            nextCursor: "x",
          },
        ])
      );
      insert(makeEntry("live", "2024-06-02T12:00:00Z"));
      await waitFor(() => expect(ids("all")).toEqual(["c", "live", "b"]));

      act(() =>
        seedList(queryClient, ALL, [
          {
            items: [makeEntry("e", "2024-06-05"), makeEntry("d", "2024-06-04")],
            nextCursor: "y",
          },
        ])
      );

      await waitFor(() => expect(ids("all")).toEqual(["e", "d"]));
    });

    it("drops an entry inserted before the refetch started that the server no longer returns", async () => {
      const { insertLive, refetch, ids } = renderRefetchableList();
      await waitFor(() => expect(ids()).toEqual(["a"]));

      insertLive();
      await refetch()();

      expect(ids()).toEqual(["a"]);
    });
  });

  it("keeps an entry that was marked read in an unread-only list (membership never follows state)", async () => {
    const { queryClient, result } = renderLists({ all: ALL });
    act(() => seedList(queryClient, ALL, [{ items: [makeEntry("a", "2024-06-01")] }]));
    act(() =>
      setServerEntryState(getLocalDb(queryClient).entries, "a", {
        read: true,
        starred: false,
        updatedAt: new Date("2024-08-01T00:00:00Z"),
      })
    );
    await waitFor(() => expect(result.current.all).toMatchObject([{ id: "a", read: true }]));
  });

  it("drops a list's rows when its query is removed from the cache", async () => {
    const { queryClient, ids } = renderLists({ all: ALL });
    act(() => seedList(queryClient, ALL, [{ items: [makeEntry("a", "2024-06-01")] }]));
    await waitFor(() => expect(ids("all")).toEqual(["a"]));
    act(() => queryClient.removeQueries({ queryKey: [["entries", "list"]] }));
    await waitFor(() => expect(ids("all")).toEqual([]));
  });
});

describe("live inserts - sorted position", () => {
  it("inserts an older entry in sorted position (feed backfill)", async () => {
    const { queryClient, ids, insert } = renderLists({ all: ALL });
    act(() =>
      seedList(queryClient, ALL, [
        { items: [makeEntry("c", "2024-06-03"), makeEntry("a", "2024-06-01")] },
      ])
    );
    insert(makeEntry("b", "2024-06-02"));
    await waitFor(() => expect(ids("all")).toEqual(["c", "b", "a"]));
  });

  it("sorts by fetchedAt when publishedAt is null", async () => {
    const { queryClient, ids, insert } = renderLists({ all: ALL });
    act(() =>
      seedList(queryClient, ALL, [
        { items: [makeEntry("c", "2024-06-03"), makeEntry("a", "2024-06-01")] },
      ])
    );
    insert({ ...makeEntry("b", "2024-06-02"), publishedAt: null });
    await waitFor(() => expect(ids("all")).toEqual(["c", "b", "a"]));
  });

  it("skips an entry that sorts beyond a partially-loaded window", async () => {
    const { queryClient, ids, insert } = renderLists({ all: ALL });
    act(() =>
      seedList(queryClient, ALL, [{ items: [makeEntry("a", "2024-06-01")], nextCursor: "c" }])
    );
    insert(makeEntry("older", "2024-05-01"));
    await waitFor(() => expect(ids("all")).toEqual(["a"]));
  });

  it("appends an entry that sorts last when the list is fully loaded", async () => {
    const { queryClient, ids, insert } = renderLists({ all: ALL });
    act(() => seedList(queryClient, ALL, [{ items: [makeEntry("a", "2024-06-01")] }]));
    insert(makeEntry("older", "2024-05-01"));
    await waitFor(() => expect(ids("all")).toEqual(["a", "older"]));
  });

  it("inserts into an empty, fully-loaded list", async () => {
    const { queryClient, ids, insert } = renderLists({ all: ALL });
    act(() => seedList(queryClient, ALL, [{ items: [] }]));
    insert(makeEntry("new", "2024-07-01"));
    await waitFor(() => expect(ids("all")).toEqual(["new"]));
  });

  it("orders an oldest-sorted list ascending and skips it when pages are unloaded", async () => {
    const oldest = { ...ALL, sortOrder: "oldest" };
    const partial = { ...ALL, sortOrder: "oldest", limit: 5 };
    const { queryClient, ids, insert } = renderLists({ oldest, partial });
    act(() => {
      seedList(queryClient, oldest, [{ items: [makeEntry("a", "2024-06-01")] }]);
      seedList(queryClient, partial, [{ items: [makeEntry("a", "2024-06-01")], nextCursor: "c" }]);
    });
    insert(makeEntry("new", "2024-07-01"));
    await waitFor(() => expect(ids("oldest")).toEqual(["a", "new"]));
    expect(ids("partial")).toEqual(["a"]);
  });

  it("is idempotent: inserting the same entry twice keeps one copy", async () => {
    const { queryClient, ids, insert } = renderLists({ all: ALL });
    act(() => seedList(queryClient, ALL, [{ items: [makeEntry("a", "2024-06-01")] }]));
    insert(makeEntry("new", "2024-07-01"));
    insert(makeEntry("new", "2024-07-01"));
    await waitFor(() => expect(ids("all")).toEqual(["new", "a"]));
  });
});

describe("live inserts - filter targeting", () => {
  const seedEmpty = (queryClient: QueryClient, inputs: Record<string, ListInput>) =>
    act(() => {
      for (const input of Object.values(inputs)) seedList(queryClient, input, [{ items: [] }]);
    });

  it("targets subscription, tag and uncategorized lists by the cached subscription", async () => {
    const inputs = {
      sub1: { ...ALL, subscriptionId: "sub-1" },
      sub2: { ...ALL, subscriptionId: "sub-2" },
      tag1: { ...ALL, tagId: "tag-1" },
      tag2: { ...ALL, tagId: "tag-2" },
      uncategorized: { ...ALL, uncategorized: true },
    };
    const { queryClient, ids, insert } = renderLists(inputs);
    seedSubscription(queryClient, "sub-1", [{ id: "tag-1", name: "Tech" }]);
    seedSubscription(queryClient, "sub-2");
    seedEmpty(queryClient, inputs);

    insert(makeEntry("tagged", "2024-07-01"));
    insert(makeEntry("untagged", "2024-07-02", { subscriptionId: "sub-2" }));

    await waitFor(() => expect(ids("sub1")).toEqual(["tagged"]));
    expect(ids("sub2")).toEqual(["untagged"]);
    expect(ids("tag1")).toEqual(["tagged"]);
    expect(ids("tag2")).toEqual([]);
    expect(ids("uncategorized")).toEqual(["untagged"]);
  });

  it("skips tag and uncategorized lists when the subscription is not cached", async () => {
    const inputs = {
      tag1: { ...ALL, tagId: "tag-1" },
      uncategorized: { ...ALL, uncategorized: true },
      all: ALL,
    };
    const { queryClient, ids, insert } = renderLists(inputs);
    seedEmpty(queryClient, inputs);
    insert(makeEntry("e", "2024-07-01"));
    await waitFor(() => expect(ids("all")).toEqual(["e"]));
    expect(ids("tag1")).toEqual([]);
    expect(ids("uncategorized")).toEqual([]);
  });

  it("honors starred, unread and type filters", async () => {
    const inputs = {
      starred: { ...ALL, starredOnly: true },
      unread: ALL,
      saved: { ...ALL, type: "saved" },
    };
    const { queryClient, ids, insert } = renderLists(inputs);
    seedEmpty(queryClient, inputs);
    insert(makeEntry("plain", "2024-07-01"));
    insert(makeEntry("read", "2024-07-02", { read: true }));
    insert(makeEntry("starred", "2024-07-03", { starred: true }));
    insert(makeEntry("saved", "2024-07-04", { type: "saved", subscriptionId: null }));

    await waitFor(() => expect(ids("unread")).toEqual(["saved", "starred", "plain"]));
    expect(ids("starred")).toEqual(["starred"]);
    expect(ids("saved")).toEqual(["saved"]);
  });

  it("skips search results, Recently Read, and lists with unknown filter keys", async () => {
    const inputs = {
      search: { ...ALL, query: "react" },
      recentlyRead: { ...ALL, unreadOnly: false, sortBy: "readChanged" },
      unknown: { ...ALL, excludeTypes: ["saved"] },
    };
    const { queryClient, ids, insert } = renderLists(inputs);
    seedEmpty(queryClient, inputs);
    insert(makeEntry("e", "2024-07-01"));
    await act(async () => {});
    expect(ids("search")).toEqual([]);
    expect(ids("recentlyRead")).toEqual([]);
    expect(ids("unknown")).toEqual([]);
  });
});

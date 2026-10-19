/**
 * The local store's unread counts and tags: how `entries.countLists` and
 * `tags.list` results combine with live writes.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { getLocalDb } from "@/lib/local-db/local-db";
import { applyTagChange } from "@/lib/cache/operations";
import { storedCount, storedTagsList } from "../../../utils/cache-test-helpers";

const EARLIER = "2026-01-01T00:00:00.000001Z";
const LATER = "2026-01-01T00:00:00.000002Z";

const COUNT_LISTS_KEY = [["entries", "countLists"], { type: "query" }];

function listCounts(all: number, asOf: string) {
  return { all, starred: 2, saved: 1, uncategorized: 3, asOf };
}
const TAGS_KEY = [["tags", "list"], { type: "query" }];

function tagsList(tags: Array<{ id: string; name: string; unreadCount: number }>, asOf: string) {
  return {
    items: tags.map((tag) => ({
      color: null,
      feedCount: 1,
      createdAt: new Date("2026-01-01"),
      ...tag,
    })),
    uncategorized: { feedCount: 0, unreadCount: 7 },
    asOf,
  };
}

/** Starts a fetch whose response is held until `release`. */
function fetching<T>(queryClient: QueryClient, queryKey: unknown[], data: T) {
  let release = () => {};
  const response = new Promise<T>((resolve) => {
    release = () => resolve(data);
  });
  const done = queryClient.fetchQuery({ queryKey, queryFn: () => response, staleTime: 0 });
  return {
    settle: async () => {
      release();
      await done;
    },
  };
}

describe("unread counts", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    getLocalDb(queryClient);
  });

  it("stores each count of an entries.countLists result under its list", () => {
    queryClient.setQueryData(COUNT_LISTS_KEY, listCounts(4, EARLIER));

    expect([
      storedCount(queryClient, { all: true }),
      storedCount(queryClient, { starred: true }),
      storedCount(queryClient, { saved: true }),
      storedCount(queryClient, { uncategorized: true }),
    ]).toEqual([{ unread: 4 }, { unread: 2 }, { unread: 1 }, { unread: 3 }]);
  });

  it("keeps a newer count over a fetched one read before it", () => {
    queryClient.setQueryData(COUNT_LISTS_KEY, listCounts(4, LATER));
    queryClient.setQueryData(COUNT_LISTS_KEY, listCounts(9, EARLIER));

    expect(storedCount(queryClient, { all: true })).toEqual({ unread: 4 });
  });
});

describe("tags", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    getLocalDb(queryClient);
  });

  it("stores a tags.list result's tags and their counts", () => {
    queryClient.setQueryData(
      TAGS_KEY,
      tagsList([{ id: "tag-1", name: "One", unreadCount: 3 }], EARLIER)
    );

    expect(storedTagsList(queryClient)).toMatchObject({
      items: [{ id: "tag-1", name: "One", feedCount: 1, unreadCount: 3 }],
      uncategorized: { unreadCount: 7 },
    });
  });

  it("drops a tag a later tags.list doesn't return", async () => {
    queryClient.setQueryData(
      TAGS_KEY,
      tagsList([{ id: "tag-1", name: "One", unreadCount: 3 }], EARLIER)
    );

    await fetching(queryClient, TAGS_KEY, tagsList([], LATER)).settle();

    expect(storedTagsList(queryClient)?.items).toEqual([]);
    expect(storedCount(queryClient, { tagId: "tag-1" })).toBeUndefined();
  });

  it("keeps a tag created, or renamed, while a fetch that predates it ran", async () => {
    queryClient.setQueryData(
      TAGS_KEY,
      tagsList([{ id: "tag-1", name: "One", unreadCount: 3 }], EARLIER)
    );
    const refetch = fetching(
      queryClient,
      TAGS_KEY,
      tagsList([{ id: "tag-1", name: "One", unreadCount: 3 }], LATER)
    );
    applyTagChange(queryClient, { id: "tag-1", name: "Renamed", color: null });
    applyTagChange(queryClient, { id: "tag-2", name: "New", color: null });
    await refetch.settle();

    expect(storedTagsList(queryClient)?.items.map((tag) => tag.name)).toEqual(["New", "Renamed"]);
  });
});

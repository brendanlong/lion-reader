/**
 * The local store's unread counts and tags: how `entries.count` and
 * `tags.list` results combine with live writes.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { getLocalDb } from "@/lib/local-db/local-db";
import { writeLiveSubscriptions } from "@/lib/local-db/subscriptions";
import { applyTagChange } from "@/lib/cache/operations";
import {
  createSubscriptionRow,
  storedCount,
  storedTagsList,
} from "../../../utils/cache-test-helpers";

const EARLIER = "2026-01-01T00:00:00.000001Z";
const LATER = "2026-01-01T00:00:00.000002Z";

const countKey = (input: Record<string, unknown>) => [
  ["entries", "count"],
  { input, type: "query" },
];
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

  it("stores an entries.count result under its list", () => {
    queryClient.setQueryData(countKey({ tagId: "tag-1" }), { unread: 4, asOf: EARLIER });

    expect(storedCount(queryClient, { tagId: "tag-1" })).toEqual({ unread: 4 });
  });

  it("keeps a newer count over a fetched one read before it", () => {
    queryClient.setQueryData(countKey({}), { unread: 4, asOf: LATER });
    queryClient.setQueryData(countKey({}), { unread: 9, asOf: EARLIER });

    expect(storedCount(queryClient, {})).toEqual({ unread: 4 });
  });

  it("puts a subscription's count on its stored row", () => {
    const db = getLocalDb(queryClient);
    writeLiveSubscriptions(db.subscriptions, [createSubscriptionRow({ id: "sub-1" })]);

    queryClient.setQueryData(countKey({ subscriptionId: "sub-1" }), { unread: 6, asOf: LATER });

    expect(db.subscriptions.rows.getSynced("sub-1")?.unreadCount).toBe(6);
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

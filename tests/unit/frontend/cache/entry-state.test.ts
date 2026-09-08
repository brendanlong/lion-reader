/**
 * Tests for getCachedEntryState + updateEntryState — the snapshot and the
 * fused read/starred write that useEntryMutations' optimistic updates and
 * their reconciliation go through.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { getCachedEntryState, updateEntryState } from "@/lib/cache/entry-cache";
import { _resetSubscriptionLookupMap } from "@/lib/cache/count-cache";
import type { TRPCClientUtils } from "@/lib/trpc/client";
import { createRealTrpcUtils, getUtilsData, setUtilsData } from "../../../utils/cache-test-helpers";

let queryClient: QueryClient;
let utils: TRPCClientUtils;

const listKey = (input: Record<string, unknown>) => [
  ["entries", "list"],
  { input: { limit: 25, ...input }, type: "infinite" },
];

function seedList(
  input: Record<string, unknown>,
  entries: Array<{ id: string; read: boolean; starred: boolean; [key: string]: unknown }>
): void {
  queryClient.setQueryData(listKey(input), {
    pages: [{ items: entries, nextCursor: undefined }],
    pageParams: [undefined],
  });
}

function listItems(
  input: Record<string, unknown>
): Array<{ id: string; read: boolean; starred: boolean }> {
  const data = queryClient.getQueryData<{
    pages: Array<{ items: Array<{ id: string; read: boolean; starred: boolean }> }>;
  }>(listKey(input));
  return data?.pages.flatMap((p) => p.items) ?? [];
}

beforeEach(() => {
  _resetSubscriptionLookupMap();
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  utils = createRealTrpcUtils(queryClient);
});

describe("getCachedEntryState", () => {
  it("falls back to the list cache when entries.get is absent", () => {
    // Entry acted on from the list view: it lives in entries.list but has no
    // entries.get cache entry. The rollback snapshot must capture its real
    // state so a failed mark-unread rolls back to read, not to the state the
    // failed mutation wanted.
    seedList({}, [{ id: "e1", read: true, starred: true }]);

    expect(getCachedEntryState(utils, queryClient, "e1")).toEqual({ read: true, starred: true });
  });

  it("prefers the entries.get value when it exists", () => {
    setUtilsData(
      utils.entries.get,
      { id: "e1" },
      { entry: { id: "e1", read: true, starred: false, updatedAt: new Date() } }
    );
    // A stale list copy with a different value must not win over entries.get.
    seedList({}, [{ id: "e1", read: false, starred: true }]);

    expect(getCachedEntryState(utils, queryClient, "e1")).toEqual({ read: true, starred: false });
  });

  it("returns undefined when the entry is in no cache", () => {
    expect(getCachedEntryState(utils, queryClient, "e1")).toBeUndefined();
  });
});

describe("updateEntryState", () => {
  it("writes both fields to entries.get and every list in one call", () => {
    setUtilsData(
      utils.entries.get,
      { id: "e1" },
      { entry: { id: "e1", read: false, starred: false, updatedAt: new Date() } }
    );
    seedList({}, [{ id: "e1", read: false, starred: false }]);
    seedList({ starredOnly: true }, [{ id: "e1", read: false, starred: false }]);

    updateEntryState(utils, queryClient, "e1", { read: true, starred: true });

    expect(
      getUtilsData<{ entry: { read: boolean; starred: boolean } }>(utils.entries.get, { id: "e1" })
        ?.entry
    ).toMatchObject({
      read: true,
      starred: true,
    });
    expect(listItems({})).toEqual([{ id: "e1", read: true, starred: true }]);
    expect(listItems({ starredOnly: true })).toEqual([{ id: "e1", read: true, starred: true }]);
  });

  it("restores an entry becoming unread into unreadOnly lists that lack it", () => {
    seedList({}, [
      {
        id: "e1",
        subscriptionId: null,
        feedId: "feed-1",
        type: "web",
        url: null,
        title: "One",
        author: null,
        summary: null,
        publishedAt: new Date("2024-06-01"),
        fetchedAt: new Date("2024-06-01"),
        updatedAt: new Date("2024-06-01"),
        read: true,
        starred: false,
        feedTitle: null,
        siteName: null,
      },
    ]);
    seedList({ unreadOnly: true }, []);

    updateEntryState(utils, queryClient, "e1", { read: false, starred: false });

    expect(listItems({ unreadOnly: true }).map((e) => e.id)).toEqual(["e1"]);
    expect(listItems({})[0]).toMatchObject({ read: false });
  });

  it("leaves an absent entries.get untouched", () => {
    updateEntryState(utils, queryClient, "e1", { read: true, starred: true });
    expect(getUtilsData(utils.entries.get, { id: "e1" })).toBeUndefined();
  });
});

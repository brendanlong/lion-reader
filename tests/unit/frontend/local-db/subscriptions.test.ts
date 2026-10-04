/**
 * The local subscription store: what a sidebar section shows, and how fetched
 * pages, live writes and refetches combine in it.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { getLocalDb } from "@/lib/local-db/local-db";
import {
  patchLiveSubscription,
  removeLiveSubscriptions,
  sidebarSectionRows,
  type SubscriptionRow,
} from "@/lib/local-db/subscriptions";

function sub(id: string, title: string, overrides: Partial<SubscriptionRow> = {}): SubscriptionRow {
  return {
    id,
    type: "web",
    url: null,
    title,
    originalTitle: title,
    description: null,
    siteUrl: null,
    subscribedAt: new Date("2024-01-01"),
    unreadCount: 1,
    tags: [{ id: "tag-1", name: "Tag", color: null }],
    fetchFullContent: false,
    ...overrides,
  };
}

const pages = (items: SubscriptionRow[], nextCursor?: string) => ({
  pages: [{ items, nextCursor }],
});

describe("sidebarSectionRows", () => {
  const section = { section: "tag-1", unreadOnly: true, openSubscriptionId: undefined };

  it("shows the section's unread rows, plus the open one once read", () => {
    const loaded = sub("a", "A");
    const read = sub("b", "B", { unreadCount: 0 });
    const open = sub("c", "C", { unreadCount: 0 });
    const elsewhere = sub("d", "D", { tags: [] });

    const rows = sidebarSectionRows([loaded, read, open, elsewhere], {
      ...section,
      data: pages([loaded, read, open]),
      openSubscriptionId: "c",
    });

    expect(rows.map((row) => row.id)).toEqual(["a", "c"]);
  });

  it("keeps the server's order for loaded rows and slots others in by title", () => {
    // The server's collation put "beta" before "Alpha" here; a row that
    // arrived another way goes where its title sorts.
    const beta = sub("b", "beta");
    const alpha = sub("a", "Alpha");
    const zed = sub("z", "Zed");

    const rows = sidebarSectionRows([alpha, zed, beta], { ...section, data: pages([beta, alpha]) });

    expect(rows.map((row) => row.id)).toEqual(["b", "a", "z"]);
  });

  it("with more pages, shows only rows sorting before the last loaded one", () => {
    const m = sub("m", "M");
    const early = sub("a", "A");
    const late = sub("z", "Z");

    const rows = sidebarSectionRows([m, early, late], { ...section, data: pages([m], "next") });

    expect(rows.map((row) => row.id)).toEqual(["a", "m"]);
  });
});

describe("ingesting subscription queries", () => {
  let queryClient: QueryClient;
  const sectionInput = { tagId: "tag-1", unreadOnly: true, limit: 50 };
  const sectionKey = [["subscriptions", "list"], { input: sectionInput, type: "infinite" }];
  const store = () => getLocalDb(queryClient).subscriptions;
  const stored = (id: string) => store().rows.getSynced(id);

  /** Fetches the section, resolving with `items` once `release` is called. */
  function fetchSection(items: SubscriptionRow[], nextCursor?: string) {
    let release = () => {};
    const done = queryClient.fetchInfiniteQuery({
      queryKey: sectionKey,
      queryFn: () =>
        new Promise<{ items: SubscriptionRow[]; nextCursor?: string }>((resolve) => {
          release = () => resolve({ items, nextCursor });
        }),
      initialPageParam: undefined,
      staleTime: 0,
    });
    return { release: () => release(), done };
  }

  async function fetchedSection(items: SubscriptionRow[], nextCursor?: string) {
    const fetch = fetchSection(items, nextCursor);
    fetch.release();
    await fetch.done;
  }

  beforeEach(() => {
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    getLocalDb(queryClient);
  });

  it("stores fetched rows, except over a live write made while the fetch ran", async () => {
    await fetchedSection([sub("a", "A", { unreadCount: 3 })]);
    const refetch = fetchSection([sub("a", "A", { unreadCount: 3 })]);
    patchLiveSubscription(store(), "a", { unreadCount: 4 });
    refetch.release();
    await refetch.done;

    expect(stored("a")?.unreadCount).toBe(4);
  });

  it("doesn't bring back a row removed while the fetch ran", async () => {
    await fetchedSection([sub("a", "A")]);
    const refetch = fetchSection([sub("a", "A")]);
    removeLiveSubscriptions(store(), ["a"]);
    refetch.release();
    await refetch.done;

    expect(stored("a")).toBeUndefined();
  });

  it("zeroes rows an unread-only refetch no longer returns, within its loaded pages", async () => {
    // Read elsewhere (say, mark-all-read): the refetch no longer returns them.
    await fetchedSection([sub("a", "A"), sub("b", "B"), sub("m", "M")], "next");
    const refetch = fetchSection([sub("m", "M")], "next");
    // Unread again after the refetch started; the refetch can't know.
    patchLiveSubscription(store(), "b", { unreadCount: 2 });
    // Past the loaded pages: not the refetch's to judge.
    store().rows.upsert([sub("z", "Z")]);
    refetch.release();
    await refetch.done;

    expect(stored("a")?.unreadCount).toBe(0);
    expect(stored("b")?.unreadCount).toBe(2);
    expect(stored("z")?.unreadCount).toBe(1);
  });

  it("leaves counts alone when a manual write, not a fetch, replaces the pages", async () => {
    await fetchedSection([sub("a", "A")]);

    queryClient.setQueryData(sectionKey, { pages: [{ items: [] }], pageParams: [undefined] });

    expect(stored("a")?.unreadCount).toBe(1);
  });
});

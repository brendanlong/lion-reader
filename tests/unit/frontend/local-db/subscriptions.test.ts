/**
 * The local subscription store: what a sidebar section shows, and how fetched
 * pages, live writes and refetches combine in it.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { InfiniteQueryObserver, QueryClient } from "@tanstack/react-query";
import { getLocalDb } from "@/lib/local-db/local-db";
import {
  patchLiveSubscription,
  removeLiveSubscriptions,
  restoreRemovedSubscription,
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
  let observer: ReturnType<typeof observeSection>;
  /** Responses by section and page: page 0 is the first. */
  let responses: Record<string, Array<() => Promise<SectionPage>>>;
  const sectionKeyFor = (tagId: string) => [
    ["subscriptions", "list"],
    { input: { tagId, unreadOnly: true, limit: 50 }, type: "infinite" },
  ];
  const store = () => getLocalDb(queryClient).subscriptions;
  const stored = (id: string) => store().rows.getSynced(id);

  type SectionPage = { items: SubscriptionRow[]; nextCursor?: string };

  /**
   * Starts a fetch of `page` (0: a full refetch) whose response is held until
   * `release` is called.
   */
  function fetching(
    page: number,
    items: SubscriptionRow[],
    nextCursor?: string,
    section = observer
  ) {
    let release = () => {};
    const response = new Promise<SectionPage>((resolve) => {
      release = () => resolve({ items, nextCursor });
    });
    const tagId = (section.options.queryKey[1] as { input: { tagId: string } }).input.tagId;
    (responses[tagId] ??= [])[page] = () => response;
    const done = page === 0 ? section.refetch() : section.fetchNextPage();
    return { release, done };
  }

  async function settled(fetch: { release: () => void; done: Promise<unknown> }) {
    fetch.release();
    await fetch.done;
  }

  beforeEach(() => {
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    getLocalDb(queryClient);
    responses = {};
    observer = observeSection("tag-1");
  });

  function observeSection(tagId: string) {
    return new InfiniteQueryObserver(queryClient, {
      queryKey: sectionKeyFor(tagId),
      queryFn: ({ pageParam }: { pageParam: number }) => responses[tagId][pageParam](),
      initialPageParam: 0,
      getNextPageParam: (last: SectionPage, all: SectionPage[]) =>
        last.nextCursor ? all.length : undefined,
      enabled: false,
    });
  }

  it("stores fetched rows, except over a write made while the fetch ran", async () => {
    const first = fetching(0, [sub("a", "A", { unreadCount: 3 })]);
    await settled(first);
    const refetch = fetching(0, [sub("a", "A", { unreadCount: 3 })]);
    patchLiveSubscription(store(), "a", { unreadCount: 4 });
    await settled(refetch);

    expect(stored("a")?.unreadCount).toBe(4);
  });

  it("doesn't bring back a row removed while the fetch ran", async () => {
    const first = fetching(0, [sub("a", "A")]);
    await settled(first);
    const refetch = fetching(0, [sub("a", "A")]);
    removeLiveSubscriptions(store(), ["a"]);
    await settled(refetch);

    expect(stored("a")).toBeUndefined();
  });

  it("stores only the new page of a next-page fetch", async () => {
    const first = fetching(0, [sub("a", "A", { unreadCount: 3 }), sub("b", "B")], "more");
    await settled(first);
    // Read, and unsubscribed, before the next page loads.
    patchLiveSubscription(store(), "a", { unreadCount: 0 });
    removeLiveSubscriptions(store(), ["b"]);
    const next = fetching(1, [sub("c", "C")]);
    await settled(next);

    expect(stored("a")?.unreadCount).toBe(0);
    expect(stored("b")).toBeUndefined();
    expect(stored("c")).toBeDefined();
  });

  it("keeps a row from a newer fetch when an older fetch of another section lands", async () => {
    const both = [
      { id: "tag-1", name: "One", color: null },
      { id: "tag-2", name: "Two", color: null },
    ];
    const other = observeSection("tag-2");
    const older = fetching(0, [sub("a", "A", { tags: both, unreadCount: 3 })], undefined, other);
    await settled(fetching(0, [sub("a", "A", { tags: both, unreadCount: 0 })]));
    await settled(older);

    expect(stored("a")?.unreadCount).toBe(0);
  });

  it("restores an optimistic removal only if nothing wrote the row since", () => {
    const row = sub("a", "A");
    store().rows.upsert([row]);
    const removedAt = removeLiveSubscriptions(store(), ["a"]);
    // The subscription_deleted event beat the mutation's (failed) response.
    removeLiveSubscriptions(store(), ["a"]);

    restoreRemovedSubscription(store(), row, removedAt);

    expect(stored("a")).toBeUndefined();
  });
});

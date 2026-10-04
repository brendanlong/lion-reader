/**
 * Unit tests for cache operations.
 *
 * These run the real cache operations against a real QueryClient and real tRPC
 * query utils (see createRealTrpcUtils), asserting on the resulting cache state
 * and on which queries were invalidated.
 */

import { describe, it, expect, beforeEach, vi, type MockInstance } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import {
  createRealTrpcUtils,
  spyOnInvalidate,
  invalidatedProcedures,
  getUtilsData,
  setUtilsData,
} from "../../../utils/cache-test-helpers";
import type { TRPCClientUtils } from "@/lib/trpc/client";
import {
  handleSubscriptionCreated,
  handleSubscriptionDeleted,
  setEntryRelatedCounts,
  type SubscriptionData,
} from "@/lib/cache/operations";
import { getLocalDb } from "@/lib/local-db/local-db";
import { writeLiveSubscriptions, type SubscriptionRow } from "@/lib/local-db/subscriptions";

// ============================================================================
// Helpers
// ============================================================================

function seedSubscription(
  queryClient: QueryClient,
  sub: Pick<SubscriptionRow, "id" | "unreadCount" | "tags">
): void {
  writeLiveSubscriptions(getLocalDb(queryClient).subscriptions, [
    {
      type: "web",
      url: null,
      title: null,
      originalTitle: null,
      description: null,
      siteUrl: null,
      subscribedAt: new Date(),
      fetchFullContent: false,
      ...sub,
    },
  ]);
}

function stored(queryClient: QueryClient, id: string): SubscriptionRow | undefined {
  return getLocalDb(queryClient).subscriptions.rows.getSynced(id);
}

// ============================================================================
// Tests
// ============================================================================

describe("handleSubscriptionCreated", () => {
  let queryClient: QueryClient;
  let utils: TRPCClientUtils;
  let invalidateSpy: MockInstance;

  beforeEach(() => {
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    utils = createRealTrpcUtils(queryClient);
    invalidateSpy = spyOnInvalidate(queryClient);
  });

  function createSubscription(overrides: Partial<SubscriptionData> = {}): SubscriptionData {
    return {
      id: "sub-1",
      type: "web",
      url: "https://example.com/feed.xml",
      title: "Example Feed",
      originalTitle: "Example Feed",
      description: "An example feed",
      siteUrl: "https://example.com",
      subscribedAt: new Date("2024-01-01"),
      unreadCount: 0,
      tags: [],
      fetchFullContent: false,
      ...overrides,
    };
  }

  it("adds the subscription to the local store", () => {
    const subscription = createSubscription({
      tags: [{ id: "tag-1", name: "News", color: "#ff0000" }],
    });
    handleSubscriptionCreated(utils, subscription, queryClient);

    expect(stored(queryClient, "sub-1")).toEqual(subscription);
  });

  it("keeps the store to its own QueryClient (a new client starts empty)", () => {
    handleSubscriptionCreated(utils, createSubscription(), queryClient);

    expect(stored(new QueryClient(), "sub-1")).toBeUndefined();
  });

  it("sets absolute counts directly when the event provides them", () => {
    // Seed tags.list so the uncategorized write has a cache to update (the
    // updater no-ops on an empty cache), letting us assert it actually happened.
    setUtilsData(utils.tags.list, undefined, {
      items: [],
      uncategorized: { feedCount: 1, unreadCount: 0 },
    });

    const subscription = createSubscription({ unreadCount: 3 });
    handleSubscriptionCreated(utils, subscription, queryClient, {
      all: { unread: 21 },
      starred: { unread: 1 },
      saved: { unread: 1 },
      subscriptions: [{ id: "sub-1", unread: 3 }],
      tags: [],
      uncategorized: { unread: 6 },
    });

    // Counts are set directly, not invalidated (the subscriptions.list refresh
    // is a separate structural concern).
    expect(getUtilsData<{ unread: number }>(utils.entries.count, {})).toEqual({ unread: 21 });
    expect(getUtilsData<{ unread: number }>(utils.entries.count, { starredOnly: true })).toEqual({
      unread: 1,
    });
    expect(
      getUtilsData<{ uncategorized: { unreadCount: number } }>(utils.tags.list)?.uncategorized
        .unreadCount
    ).toBe(6);
    const paths = invalidatedProcedures(invalidateSpy);
    expect(paths).not.toContain("entries.count");
    expect(paths).not.toContain("tags.list");
  });

  it("invalidates the count caches when no counts are provided (sync catch-up)", () => {
    const subscription = createSubscription();
    handleSubscriptionCreated(utils, subscription, queryClient);

    const paths = invalidatedProcedures(invalidateSpy);
    expect(paths).toContain("tags.list");
    expect(paths).toContain("entries.count");
  });

  it("does not cause count inflation for duplicate events", () => {
    setUtilsData(utils.entries.count, {}, { unread: 10 });
    const subscription = createSubscription({ unreadCount: 5 });

    handleSubscriptionCreated(utils, subscription, queryClient);
    const countAfterFirst = getUtilsData<{ unread: number }>(utils.entries.count, {})?.unread;

    handleSubscriptionCreated(utils, subscription, queryClient);
    const countAfterSecond = getUtilsData<{ unread: number }>(utils.entries.count, {})?.unread;

    expect(countAfterSecond).toBe(countAfterFirst);
  });
});

describe("handleSubscriptionDeleted", () => {
  let queryClient: QueryClient;
  let utils: TRPCClientUtils;
  let invalidateSpy: MockInstance;

  beforeEach(() => {
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    utils = createRealTrpcUtils(queryClient);
    invalidateSpy = spyOnInvalidate(queryClient);
  });

  it("invalidates entries.list cache", () => {
    handleSubscriptionDeleted(utils, "sub-1", queryClient);

    expect(invalidatedProcedures(invalidateSpy).filter((p) => p === "entries.list")).toHaveLength(
      1
    );
  });

  it("invalidates tags.list cache when subscription not found", () => {
    handleSubscriptionDeleted(utils, "sub-1", queryClient);

    expect(invalidatedProcedures(invalidateSpy).filter((p) => p === "tags.list")).toHaveLength(1);
  });

  it("removes the subscription from the local store", () => {
    seedSubscription(queryClient, { id: "sub-1", unreadCount: 5, tags: [] });
    seedSubscription(queryClient, { id: "sub-2", unreadCount: 10, tags: [] });

    handleSubscriptionDeleted(utils, "sub-1", queryClient);

    expect(stored(queryClient, "sub-1")).toBeUndefined();
    expect(stored(queryClient, "sub-2")).toBeDefined();
  });

  it("drops the deleted subscription's subscriptions.get data", () => {
    // So its open page refetches it and finds it gone.
    setUtilsData(utils.subscriptions.get, { id: "sub-1" }, { id: "sub-1", unreadCount: 5 });

    handleSubscriptionDeleted(utils, "sub-1", queryClient);

    expect(getUtilsData(utils.subscriptions.get, { id: "sub-1" })).toBeUndefined();
  });
});

describe("setEntryRelatedCounts saved-count handling", () => {
  let queryClient: QueryClient;
  let utils: TRPCClientUtils;

  beforeEach(() => {
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    utils = createRealTrpcUtils(queryClient);
  });

  const baseCounts = {
    all: { unread: 3 },
    starred: { unread: 1 },
    subscriptions: [],
    tags: [],
  };

  it("does not fabricate a saved count when the event omits it and none is cached", () => {
    // A web/email event omits `saved`; with nothing cached there is no value to
    // preserve. Writing a { unread: 0 } here would seed a "fresh" saved count
    // that a later Saved-view mount would trust instead of fetching.
    setEntryRelatedCounts(utils, baseCounts, queryClient);

    expect(utils.entries.count.getData({ type: "saved" })).toBeUndefined();
  });

  it("preserves an existing cached saved count when the event omits it", () => {
    setUtilsData(utils.entries.count, { type: "saved" }, { unread: 4 });

    setEntryRelatedCounts(utils, baseCounts, queryClient);

    expect(utils.entries.count.getData({ type: "saved" })).toEqual({ unread: 4 });
  });

  it("writes the saved count when the event provides one", () => {
    setEntryRelatedCounts(utils, { ...baseCounts, saved: { unread: 7 } }, queryClient);

    expect(utils.entries.count.getData({ type: "saved" })).toEqual({ unread: 7 });
  });
});

describe("setEntryRelatedCounts for subscriptions", () => {
  let queryClient: QueryClient;
  let utils: TRPCClientUtils;
  let fetchedIds: () => string[];

  const counts = (subscriptions: Array<{ id: string; unread: number; tagIds?: string[] }>) => ({
    all: { unread: 1 },
    starred: { unread: 0 },
    subscriptions,
    tags: [],
  });

  beforeEach(() => {
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    utils = createRealTrpcUtils(queryClient);
    const fetchSpy = vi.spyOn(queryClient, "fetchQuery").mockResolvedValue(undefined);
    fetchedIds = () =>
      fetchSpy.mock.calls.map(
        ([options]) => (options.queryKey[1] as { input: { id: string } }).input.id
      );
    // The sidebar has loaded Tag 1's section (Tag 2 is collapsed).
    setUtilsData(
      utils.subscriptions.list,
      { tagId: "tag-1", unreadOnly: true, limit: 50 },
      {
        items: [],
      }
    );
  });

  it("sets a stored subscription's count", () => {
    seedSubscription(queryClient, { id: "sub-1", unreadCount: 5, tags: [] });

    setEntryRelatedCounts(utils, counts([{ id: "sub-1", unread: 2, tagIds: [] }]), queryClient);

    expect(stored(queryClient, "sub-1")?.unreadCount).toBe(2);
    expect(fetchedIds()).toEqual([]);
  });

  it("loads a newly unread subscription only a loaded section could list", () => {
    setEntryRelatedCounts(
      utils,
      counts([
        { id: "sub-in-loaded", unread: 1, tagIds: ["tag-1"] },
        { id: "sub-in-collapsed", unread: 1, tagIds: ["tag-2"] },
        { id: "sub-still-read", unread: 0, tagIds: ["tag-1"] },
        // A previous release's event: its tags are unknown, so it may be listed.
        { id: "sub-untold", unread: 1 },
      ]),
      queryClient
    );

    expect(fetchedIds()).toEqual(["sub-in-loaded", "sub-untold"]);
  });
});

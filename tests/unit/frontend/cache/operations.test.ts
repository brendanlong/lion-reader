/**
 * Unit tests for cache operations.
 *
 * These run the real cache operations against a real QueryClient and real tRPC
 * query utils (see createRealTrpcUtils), asserting on the resulting cache state
 * and on which queries were invalidated.
 */

import { describe, it, expect, beforeEach, type MockInstance } from "vitest";
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
  applyOptimisticReadUpdate,
  type SubscriptionData,
} from "@/lib/cache/operations";
import {
  _resetSubscriptionLookupMap,
  addSubscriptionToCache,
  getSubscriptionLookupMap,
  type CachedSubscription,
} from "@/lib/cache/count-cache";

// ============================================================================
// Helpers
// ============================================================================

/**
 * Seeds a subscription into the lookup map (the canonical source for
 * subscription data used by count calculations and event handlers).
 */
function seedSubscription(sub: {
  id: string;
  unreadCount: number;
  tags: Array<{ id: string; name: string; color: string | null }>;
}): void {
  addSubscriptionToCache({
    id: sub.id,
    type: "web",
    url: null,
    title: null,
    originalTitle: null,
    description: null,
    siteUrl: null,
    subscribedAt: new Date(),
    fetchFullContent: false,
    unreadCount: sub.unreadCount,
    tags: sub.tags,
  } as CachedSubscription & {
    type: "web";
    url: null;
    title: null;
    originalTitle: null;
    description: null;
    siteUrl: null;
    subscribedAt: Date;
    fetchFullContent: false;
  });
}

function getSubscriptionFromMap(id: string): { unreadCount: number } | undefined {
  return getSubscriptionLookupMap().get(id) as { unreadCount: number } | undefined;
}

// ============================================================================
// Tests
// ============================================================================

describe("handleSubscriptionCreated", () => {
  let queryClient: QueryClient;
  let utils: TRPCClientUtils;
  let invalidateSpy: MockInstance;

  beforeEach(() => {
    _resetSubscriptionLookupMap();
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

  it("adds subscription to lookup map", () => {
    const subscription = createSubscription();
    handleSubscriptionCreated(utils, subscription);

    expect(getSubscriptionLookupMap().has("sub-1")).toBe(true);
  });

  it("sets absolute counts directly when the event provides them", () => {
    // Seed tags.list so the uncategorized write has a cache to update (the
    // updater no-ops on an empty cache), letting us assert it actually happened.
    setUtilsData(utils.tags.list, undefined, {
      items: [],
      uncategorized: { feedCount: 1, unreadCount: 0 },
    });

    const subscription = createSubscription({ unreadCount: 3 });
    handleSubscriptionCreated(utils, subscription, undefined, {
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
    handleSubscriptionCreated(utils, subscription);

    const paths = invalidatedProcedures(invalidateSpy);
    expect(paths).toContain("tags.list");
    expect(paths).toContain("entries.count");
  });

  it("adds subscription with tags to lookup map", () => {
    const subscription = createSubscription({
      tags: [
        { id: "tag-1", name: "News", color: "#ff0000" },
        { id: "tag-2", name: "Tech", color: null },
      ],
    });
    handleSubscriptionCreated(utils, subscription);

    const cached = getSubscriptionLookupMap().get("sub-1");
    expect(cached).toBeDefined();
    expect(cached?.tags).toHaveLength(2);
  });

  it("adds subscription with non-zero unread count", () => {
    const subscription = createSubscription({ unreadCount: 42 });
    handleSubscriptionCreated(utils, subscription);

    expect(getSubscriptionFromMap("sub-1")?.unreadCount).toBe(42);
  });

  it("handles email subscription type", () => {
    const subscription = createSubscription({
      type: "email",
      url: null,
    });
    handleSubscriptionCreated(utils, subscription);

    expect(getSubscriptionLookupMap().has("sub-1")).toBe(true);
  });

  it("handles saved subscription type", () => {
    const subscription = createSubscription({
      type: "saved",
      url: null,
    });
    handleSubscriptionCreated(utils, subscription);

    expect(getSubscriptionLookupMap().has("sub-1")).toBe(true);
  });

  it("handles subscription with null optional fields", () => {
    const subscription = createSubscription({
      title: null,
      description: null,
      siteUrl: null,
    });
    handleSubscriptionCreated(utils, subscription);

    // Should not throw
    expect(getSubscriptionLookupMap().has("sub-1")).toBe(true);
  });

  it("does not cause count inflation for duplicate events", () => {
    setUtilsData(utils.entries.count, {}, { unread: 10 });
    const subscription = createSubscription({ unreadCount: 5 });

    handleSubscriptionCreated(utils, subscription);
    const countAfterFirst = getUtilsData<{ unread: number }>(utils.entries.count, {})?.unread;

    handleSubscriptionCreated(utils, subscription);
    const countAfterSecond = getUtilsData<{ unread: number }>(utils.entries.count, {})?.unread;

    expect(countAfterSecond).toBe(countAfterFirst);
  });
});

describe("handleSubscriptionDeleted", () => {
  let queryClient: QueryClient;
  let utils: TRPCClientUtils;
  let invalidateSpy: MockInstance;

  beforeEach(() => {
    _resetSubscriptionLookupMap();
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    utils = createRealTrpcUtils(queryClient);
    invalidateSpy = spyOnInvalidate(queryClient);
  });

  it("removes subscription from lookup map", () => {
    seedSubscription({ id: "sub-1", unreadCount: 5, tags: [] });

    handleSubscriptionDeleted(utils, "sub-1");

    expect(getSubscriptionLookupMap().has("sub-1")).toBe(false);
  });

  it("invalidates entries.list cache", () => {
    handleSubscriptionDeleted(utils, "sub-1");

    expect(invalidatedProcedures(invalidateSpy).filter((p) => p === "entries.list")).toHaveLength(
      1
    );
  });

  it("invalidates tags.list cache when subscription not found", () => {
    handleSubscriptionDeleted(utils, "sub-1");

    expect(invalidatedProcedures(invalidateSpy).filter((p) => p === "tags.list")).toHaveLength(1);
  });

  it("removes subscription from lookup map when present", () => {
    seedSubscription({ id: "sub-1", unreadCount: 5, tags: [] });
    seedSubscription({ id: "sub-2", unreadCount: 10, tags: [] });

    handleSubscriptionDeleted(utils, "sub-1");

    expect(getSubscriptionLookupMap().has("sub-1")).toBe(false);
    expect(getSubscriptionLookupMap().has("sub-2")).toBe(true);
  });

  it("handles deletion of non-existent subscription gracefully", () => {
    seedSubscription({ id: "sub-2", unreadCount: 10, tags: [] });

    // Should not throw
    handleSubscriptionDeleted(utils, "sub-1");

    expect(getSubscriptionLookupMap().has("sub-2")).toBe(true);
  });

  it("handles deletion when lookup map is empty", () => {
    // Should not throw
    handleSubscriptionDeleted(utils, "sub-1");

    expect(getSubscriptionLookupMap().size).toBe(0);
  });
});

describe("setEntryRelatedCounts saved-count handling", () => {
  let queryClient: QueryClient;
  let utils: TRPCClientUtils;

  beforeEach(() => {
    _resetSubscriptionLookupMap();
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

describe("applyOptimisticReadUpdate previous-state snapshot", () => {
  let queryClient: QueryClient;
  let utils: TRPCClientUtils;

  beforeEach(() => {
    _resetSubscriptionLookupMap();
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    utils = createRealTrpcUtils(queryClient);
  });

  function seedListEntry(entry: { id: string; read: boolean; starred: boolean }): void {
    queryClient.setQueryData([["entries", "list"], { input: { limit: 25 }, type: "infinite" }], {
      pages: [{ items: [entry], nextCursor: undefined }],
      pageParams: [undefined],
    });
  }

  it("falls back to the list cache for the previous read state when entries.get is absent", async () => {
    // Entry acted on from the list view: it lives in entries.list but has no
    // entries.get cache entry. The rollback snapshot must capture its real read
    // state (true) so a failed mark-unread rolls back to read, not to the state
    // the failed mutation wanted.
    seedListEntry({ id: "e1", read: true, starred: false });

    const context = await applyOptimisticReadUpdate(utils, queryClient, ["e1"], false);

    expect(context.previousEntries.get("e1")).toEqual({ read: true });
  });

  it("prefers the entries.get value when it exists", async () => {
    setUtilsData(
      utils.entries.get,
      { id: "e1" },
      { entry: { id: "e1", read: true, starred: false, updatedAt: new Date() } }
    );
    // A stale list copy with a different value must not win over entries.get.
    seedListEntry({ id: "e1", read: false, starred: false });

    const context = await applyOptimisticReadUpdate(utils, queryClient, ["e1"], false);

    expect(context.previousEntries.get("e1")).toEqual({ read: true });
  });

  it("records undefined when the entry is in no cache", async () => {
    const context = await applyOptimisticReadUpdate(utils, queryClient, ["e1"], false);

    expect(context.previousEntries.get("e1")).toBeUndefined();
  });
});

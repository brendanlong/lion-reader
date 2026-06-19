/**
 * Unit tests for cache operations.
 *
 * These tests document the behavior of cache operations without full mocking.
 * For more comprehensive testing, see the integration tests.
 *
 * Note: The cache operations call lower-level helpers that interact with
 * tRPC utils in complex ways. These tests focus on high-level behavior
 * that can be tested with the mock utils.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { createMockTrpcUtils } from "../../../utils/trpc-mock";
import {
  handleSubscriptionCreated,
  handleSubscriptionDeleted,
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
  let mockUtils: ReturnType<typeof createMockTrpcUtils>;

  beforeEach(() => {
    _resetSubscriptionLookupMap();
    mockUtils = createMockTrpcUtils();
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
    handleSubscriptionCreated(mockUtils.utils, subscription);

    expect(getSubscriptionLookupMap().has("sub-1")).toBe(true);
  });

  it("directly updates tags.list cache", () => {
    const subscription = createSubscription();
    handleSubscriptionCreated(mockUtils.utils, subscription);

    // Should use setData instead of invalidate for direct cache update
    const setDataOps = mockUtils.operations.filter(
      (op) => op.type === "setData" && op.router === "tags" && op.procedure === "list"
    );
    expect(setDataOps.length).toBe(1);
  });

  it("adds subscription with tags to lookup map", () => {
    const subscription = createSubscription({
      tags: [
        { id: "tag-1", name: "News", color: "#ff0000" },
        { id: "tag-2", name: "Tech", color: null },
      ],
    });
    handleSubscriptionCreated(mockUtils.utils, subscription);

    const cached = getSubscriptionLookupMap().get("sub-1");
    expect(cached).toBeDefined();
    expect(cached?.tags).toHaveLength(2);
  });

  it("adds subscription with non-zero unread count", () => {
    const subscription = createSubscription({ unreadCount: 42 });
    handleSubscriptionCreated(mockUtils.utils, subscription);

    expect(getSubscriptionFromMap("sub-1")?.unreadCount).toBe(42);
  });

  it("handles email subscription type", () => {
    const subscription = createSubscription({
      type: "email",
      url: null,
    });
    handleSubscriptionCreated(mockUtils.utils, subscription);

    expect(getSubscriptionLookupMap().has("sub-1")).toBe(true);
  });

  it("handles saved subscription type", () => {
    const subscription = createSubscription({
      type: "saved",
      url: null,
    });
    handleSubscriptionCreated(mockUtils.utils, subscription);

    expect(getSubscriptionLookupMap().has("sub-1")).toBe(true);
  });

  it("handles subscription with null optional fields", () => {
    const subscription = createSubscription({
      title: null,
      description: null,
      siteUrl: null,
    });
    handleSubscriptionCreated(mockUtils.utils, subscription);

    // Should not throw
    expect(getSubscriptionLookupMap().has("sub-1")).toBe(true);
  });

  it("does not cause count inflation for duplicate events", () => {
    mockUtils.setCache("entries", "count", {}, { unread: 10 });
    const subscription = createSubscription({ unreadCount: 5 });

    handleSubscriptionCreated(mockUtils.utils, subscription);
    const countAfterFirst = (mockUtils.getCache("entries", "count", {}) as { unread: number })
      .unread;

    handleSubscriptionCreated(mockUtils.utils, subscription);
    const countAfterSecond = (mockUtils.getCache("entries", "count", {}) as { unread: number })
      .unread;

    expect(countAfterSecond).toBe(countAfterFirst);
  });
});

describe("handleSubscriptionDeleted", () => {
  let mockUtils: ReturnType<typeof createMockTrpcUtils>;

  beforeEach(() => {
    _resetSubscriptionLookupMap();
    mockUtils = createMockTrpcUtils();
  });

  it("removes subscription from lookup map", () => {
    seedSubscription({ id: "sub-1", unreadCount: 5, tags: [] });

    handleSubscriptionDeleted(mockUtils.utils, "sub-1");

    expect(getSubscriptionLookupMap().has("sub-1")).toBe(false);
  });

  it("invalidates entries.list cache", () => {
    handleSubscriptionDeleted(mockUtils.utils, "sub-1");

    const invalidateOps = mockUtils.operations.filter(
      (op) => op.type === "invalidate" && op.router === "entries" && op.procedure === "list"
    );
    expect(invalidateOps.length).toBe(1);
  });

  it("invalidates tags.list cache when subscription not found", () => {
    handleSubscriptionDeleted(mockUtils.utils, "sub-1");

    const invalidateOps = mockUtils.operations.filter(
      (op) => op.type === "invalidate" && op.router === "tags" && op.procedure === "list"
    );
    expect(invalidateOps.length).toBe(1);
  });

  it("removes subscription from lookup map when present", () => {
    seedSubscription({ id: "sub-1", unreadCount: 5, tags: [] });
    seedSubscription({ id: "sub-2", unreadCount: 10, tags: [] });

    handleSubscriptionDeleted(mockUtils.utils, "sub-1");

    expect(getSubscriptionLookupMap().has("sub-1")).toBe(false);
    expect(getSubscriptionLookupMap().has("sub-2")).toBe(true);
  });

  it("handles deletion of non-existent subscription gracefully", () => {
    seedSubscription({ id: "sub-2", unreadCount: 10, tags: [] });

    // Should not throw
    handleSubscriptionDeleted(mockUtils.utils, "sub-1");

    expect(getSubscriptionLookupMap().has("sub-2")).toBe(true);
  });

  it("handles deletion when lookup map is empty", () => {
    // Should not throw
    handleSubscriptionDeleted(mockUtils.utils, "sub-1");

    expect(getSubscriptionLookupMap().size).toBe(0);
  });
});

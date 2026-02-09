/**
 * Unit tests for cache operations.
 *
 * These tests document the behavior of cache operations without full mocking.
 * For more comprehensive testing, see the integration tests.
 *
 * Note: Entry state (read, starred, score) is managed by TanStack DB collections.
 * These tests cover subscription lifecycle and count update operations.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { createMockTrpcUtils } from "../../../utils/trpc-mock";
import {
  handleNewEntry,
  handleSubscriptionCreated,
  handleSubscriptionDeleted,
  type SubscriptionData,
} from "@/lib/cache/operations";

describe("handleNewEntry", () => {
  let mockUtils: ReturnType<typeof createMockTrpcUtils>;

  beforeEach(() => {
    mockUtils = createMockTrpcUtils();
  });

  it("increments subscription unread count", () => {
    handleNewEntry(mockUtils.utils, "sub-1", "web");

    const subOps = mockUtils.operations.filter(
      (op) => op.type === "setData" && op.router === "subscriptions" && op.procedure === "list"
    );
    expect(subOps.length).toBeGreaterThan(0);
  });

  it("increments saved unread count for saved entries", () => {
    handleNewEntry(mockUtils.utils, "sub-1", "saved");

    const countOps = mockUtils.operations.filter(
      (op) => op.type === "setData" && op.router === "entries" && op.procedure === "count"
    );
    expect(countOps.length).toBeGreaterThan(0);
  });

  it("increments All Articles count but not saved count for web entries", () => {
    handleNewEntry(mockUtils.utils, "sub-1", "web");

    // For web entries, we update All Articles count but not saved count
    const countOps = mockUtils.operations.filter(
      (op) => op.type === "setData" && op.router === "entries" && op.procedure === "count"
    );
    // Only 1 operation: All Articles count (no saved count for web entries)
    expect(countOps.length).toBe(1);
  });

  it("increments All Articles count but not saved count for email entries", () => {
    handleNewEntry(mockUtils.utils, "sub-1", "email");

    // Email entries update All Articles count but don't affect saved count
    const countOps = mockUtils.operations.filter(
      (op) => op.type === "setData" && op.router === "entries" && op.procedure === "count"
    );
    // Only 1 operation: All Articles count (no saved count for email entries)
    expect(countOps.length).toBe(1);
  });
});

describe("handleSubscriptionCreated", () => {
  let mockUtils: ReturnType<typeof createMockTrpcUtils>;

  beforeEach(() => {
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

  it("adds subscription to subscriptions.list cache", () => {
    const subscription = createSubscription();
    handleSubscriptionCreated(mockUtils.utils, subscription);

    const setDataOps = mockUtils.operations.filter(
      (op) => op.type === "setData" && op.router === "subscriptions" && op.procedure === "list"
    );
    expect(setDataOps.length).toBeGreaterThan(0);
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

  it("adds subscription with tags to cache", () => {
    const subscription = createSubscription({
      tags: [
        { id: "tag-1", name: "News", color: "#ff0000" },
        { id: "tag-2", name: "Tech", color: null },
      ],
    });
    handleSubscriptionCreated(mockUtils.utils, subscription);

    const setDataOps = mockUtils.operations.filter(
      (op) => op.type === "setData" && op.router === "subscriptions" && op.procedure === "list"
    );
    expect(setDataOps.length).toBeGreaterThan(0);
  });

  it("adds subscription with non-zero unread count", () => {
    const subscription = createSubscription({ unreadCount: 42 });
    handleSubscriptionCreated(mockUtils.utils, subscription);

    const setDataOps = mockUtils.operations.filter(
      (op) => op.type === "setData" && op.router === "subscriptions" && op.procedure === "list"
    );
    expect(setDataOps.length).toBeGreaterThan(0);
  });

  it("handles email subscription type", () => {
    const subscription = createSubscription({
      type: "email",
      url: null,
    });
    handleSubscriptionCreated(mockUtils.utils, subscription);

    const setDataOps = mockUtils.operations.filter(
      (op) => op.type === "setData" && op.router === "subscriptions" && op.procedure === "list"
    );
    expect(setDataOps.length).toBeGreaterThan(0);
  });

  it("handles saved subscription type", () => {
    const subscription = createSubscription({
      type: "saved",
      url: null,
    });
    handleSubscriptionCreated(mockUtils.utils, subscription);

    const setDataOps = mockUtils.operations.filter(
      (op) => op.type === "setData" && op.router === "subscriptions" && op.procedure === "list"
    );
    expect(setDataOps.length).toBeGreaterThan(0);
  });

  it("handles subscription with null optional fields", () => {
    const subscription = createSubscription({
      title: null,
      description: null,
      siteUrl: null,
    });
    handleSubscriptionCreated(mockUtils.utils, subscription);

    // Should not throw
    const setDataOps = mockUtils.operations.filter(
      (op) => op.type === "setData" && op.router === "subscriptions" && op.procedure === "list"
    );
    expect(setDataOps.length).toBeGreaterThan(0);
  });

  it("does not duplicate subscription if already in cache", () => {
    const subscription = createSubscription();

    // Set up cache with existing subscription
    mockUtils.setCache("subscriptions", "list", undefined, {
      items: [subscription],
    });

    handleSubscriptionCreated(mockUtils.utils, subscription);

    // The setData is still called, but the updater function should not add a duplicate
    const cachedData = mockUtils.getCache("subscriptions", "list", undefined) as {
      items: SubscriptionData[];
    };
    expect(cachedData.items.length).toBe(1);
  });
});

describe("handleSubscriptionDeleted", () => {
  let mockUtils: ReturnType<typeof createMockTrpcUtils>;

  beforeEach(() => {
    mockUtils = createMockTrpcUtils();
  });

  it("removes subscription from subscriptions.list cache", () => {
    handleSubscriptionDeleted(mockUtils.utils, "sub-1");

    const setDataOps = mockUtils.operations.filter(
      (op) => op.type === "setData" && op.router === "subscriptions" && op.procedure === "list"
    );
    expect(setDataOps.length).toBe(1);
  });

  it("invalidates entries.list cache", () => {
    handleSubscriptionDeleted(mockUtils.utils, "sub-1");

    const invalidateOps = mockUtils.operations.filter(
      (op) => op.type === "invalidate" && op.router === "entries" && op.procedure === "list"
    );
    expect(invalidateOps.length).toBe(1);
  });

  it("invalidates tags.list cache", () => {
    handleSubscriptionDeleted(mockUtils.utils, "sub-1");

    const invalidateOps = mockUtils.operations.filter(
      (op) => op.type === "invalidate" && op.router === "tags" && op.procedure === "list"
    );
    expect(invalidateOps.length).toBe(1);
  });

  it("removes subscription from cache when present", () => {
    // Set up cache with subscriptions
    mockUtils.setCache("subscriptions", "list", undefined, {
      items: [
        { id: "sub-1", unreadCount: 5, tags: [] },
        { id: "sub-2", unreadCount: 10, tags: [] },
      ],
    });

    handleSubscriptionDeleted(mockUtils.utils, "sub-1");

    const cachedData = mockUtils.getCache("subscriptions", "list", undefined) as {
      items: Array<{ id: string }>;
    };
    expect(cachedData.items.length).toBe(1);
    expect(cachedData.items[0].id).toBe("sub-2");
  });

  it("handles deletion of non-existent subscription gracefully", () => {
    // Set up cache with different subscription
    mockUtils.setCache("subscriptions", "list", undefined, {
      items: [{ id: "sub-2", unreadCount: 10, tags: [] }],
    });

    // Should not throw
    handleSubscriptionDeleted(mockUtils.utils, "sub-1");

    const cachedData = mockUtils.getCache("subscriptions", "list", undefined) as {
      items: Array<{ id: string }>;
    };
    expect(cachedData.items.length).toBe(1);
  });

  it("handles deletion when cache is empty", () => {
    mockUtils.setCache("subscriptions", "list", undefined, { items: [] });

    // Should not throw
    handleSubscriptionDeleted(mockUtils.utils, "sub-1");

    const cachedData = mockUtils.getCache("subscriptions", "list", undefined) as {
      items: Array<{ id: string }>;
    };
    expect(cachedData.items.length).toBe(0);
  });
});

describe("cache update logic verification", () => {
  let mockUtils: ReturnType<typeof createMockTrpcUtils>;

  beforeEach(() => {
    mockUtils = createMockTrpcUtils();
  });

  describe("handleNewEntry cache state updates", () => {
    it("increments subscription unread count", () => {
      mockUtils.setCache("subscriptions", "list", undefined, {
        items: [{ id: "sub-1", unreadCount: 5, tags: [] }],
      });

      handleNewEntry(mockUtils.utils, "sub-1", "web");

      const cachedData = mockUtils.getCache("subscriptions", "list", undefined) as {
        items: Array<{ id: string; unreadCount: number }>;
      };
      expect(cachedData.items[0].unreadCount).toBe(6);
    });

    it("increments tag unread count for subscription with tags", () => {
      mockUtils.setCache("subscriptions", "list", undefined, {
        items: [
          {
            id: "sub-1",
            unreadCount: 5,
            tags: [{ id: "tag-1", name: "News", color: null }],
          },
        ],
      });
      mockUtils.setCache("tags", "list", undefined, {
        items: [{ id: "tag-1", name: "News", color: null, unreadCount: 10 }],
      });

      handleNewEntry(mockUtils.utils, "sub-1", "web");

      const tagData = mockUtils.getCache("tags", "list", undefined) as {
        items: Array<{ id: string; unreadCount: number }>;
      };
      expect(tagData.items[0].unreadCount).toBe(11);
    });
  });
});

describe("edge cases", () => {
  let mockUtils: ReturnType<typeof createMockTrpcUtils>;

  beforeEach(() => {
    mockUtils = createMockTrpcUtils();
  });

  describe("null/undefined handling", () => {
    it("handleNewEntry handles when subscriptions cache is undefined", () => {
      // Don't set up subscriptions cache - leave it undefined
      // Should not throw
      handleNewEntry(mockUtils.utils, "sub-1", "web");
    });
  });
});

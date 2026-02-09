/**
 * Unit tests for cache operations.
 *
 * These operations now update TanStack DB collections only (no React Query cache writes).
 * Tests verify correct behavior by passing null collections (no-op mode)
 * and ensuring functions don't throw. Collection state updates are tested
 * via integration tests.
 */

import { describe, it, expect } from "vitest";
import { createMockTrpcUtils } from "../../../utils/trpc-mock";
import {
  handleNewEntry,
  handleSubscriptionCreated,
  handleSubscriptionDeleted,
  setCounts,
  setBulkCounts,
  refreshGlobalCounts,
  type SubscriptionData,
  type UnreadCounts,
  type BulkUnreadCounts,
} from "@/lib/cache/operations";

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

describe("handleNewEntry", () => {
  it("handles web entry without collections (no-op)", () => {
    const mockUtils = createMockTrpcUtils();
    // Should not throw when collections is null
    handleNewEntry(mockUtils.utils, "sub-1", "web", null);
  });

  it("handles saved entry without collections (no-op)", () => {
    const mockUtils = createMockTrpcUtils();
    handleNewEntry(mockUtils.utils, "sub-1", "saved", null);
  });

  it("handles email entry without collections (no-op)", () => {
    const mockUtils = createMockTrpcUtils();
    handleNewEntry(mockUtils.utils, "sub-1", "email", null);
  });

  it("handles null subscriptionId", () => {
    const mockUtils = createMockTrpcUtils();
    handleNewEntry(mockUtils.utils, null, "web", null);
  });
});

describe("handleSubscriptionCreated", () => {
  it("handles subscription without collections (no-op)", () => {
    const mockUtils = createMockTrpcUtils();
    const subscription = createSubscription();
    handleSubscriptionCreated(mockUtils.utils, subscription, null);
  });

  it("handles subscription with tags without collections", () => {
    const mockUtils = createMockTrpcUtils();
    const subscription = createSubscription({
      tags: [
        { id: "tag-1", name: "News", color: "#ff0000" },
        { id: "tag-2", name: "Tech", color: null },
      ],
    });
    handleSubscriptionCreated(mockUtils.utils, subscription, null);
  });

  it("handles subscription with non-zero unread count", () => {
    const mockUtils = createMockTrpcUtils();
    const subscription = createSubscription({ unreadCount: 42 });
    handleSubscriptionCreated(mockUtils.utils, subscription, null);
  });

  it("handles email subscription type", () => {
    const mockUtils = createMockTrpcUtils();
    const subscription = createSubscription({ type: "email", url: null });
    handleSubscriptionCreated(mockUtils.utils, subscription, null);
  });

  it("handles saved subscription type", () => {
    const mockUtils = createMockTrpcUtils();
    const subscription = createSubscription({ type: "saved", url: null });
    handleSubscriptionCreated(mockUtils.utils, subscription, null);
  });

  it("handles subscription with null optional fields", () => {
    const mockUtils = createMockTrpcUtils();
    const subscription = createSubscription({
      title: null,
      description: null,
      siteUrl: null,
    });
    handleSubscriptionCreated(mockUtils.utils, subscription, null);
  });
});

describe("handleSubscriptionDeleted", () => {
  it("invalidates entries.list", () => {
    const mockUtils = createMockTrpcUtils();
    handleSubscriptionDeleted(mockUtils.utils, "sub-1", null);

    // entries.list invalidation is the only React Query operation remaining
    const invalidateOps = mockUtils.operations.filter(
      (op) => op.type === "invalidate" && op.router === "entries" && op.procedure === "list"
    );
    expect(invalidateOps.length).toBe(1);
  });

  it("handles deletion without collections (no-op for collection writes)", () => {
    const mockUtils = createMockTrpcUtils();
    handleSubscriptionDeleted(mockUtils.utils, "sub-1", null);
  });
});

describe("setCounts", () => {
  it("handles counts without collections (no-op)", () => {
    const counts: UnreadCounts = {
      all: { total: 100, unread: 50 },
      starred: { total: 10, unread: 5 },
      saved: { total: 20, unread: 10 },
      subscription: { id: "sub-1", unread: 3 },
      tags: [{ id: "tag-1", unread: 5 }],
      uncategorized: { unread: 2 },
    };
    setCounts(null, counts);
  });

  it("handles counts without optional fields", () => {
    const counts: UnreadCounts = {
      all: { total: 100, unread: 50 },
      starred: { total: 10, unread: 5 },
    };
    setCounts(null, counts);
  });
});

describe("setBulkCounts", () => {
  it("handles bulk counts without collections (no-op)", () => {
    const counts: BulkUnreadCounts = {
      all: { total: 100, unread: 50 },
      starred: { total: 10, unread: 5 },
      saved: { total: 20, unread: 10 },
      subscriptions: [
        { id: "sub-1", unread: 3 },
        { id: "sub-2", unread: 7 },
      ],
      tags: [{ id: "tag-1", unread: 5 }],
      uncategorized: { unread: 2 },
    };
    setBulkCounts(null, counts);
  });

  it("handles bulk counts without uncategorized", () => {
    const counts: BulkUnreadCounts = {
      all: { total: 100, unread: 50 },
      starred: { total: 10, unread: 5 },
      saved: { total: 20, unread: 10 },
      subscriptions: [],
      tags: [],
    };
    setBulkCounts(null, counts);
  });
});

describe("refreshGlobalCounts", () => {
  it("does nothing with null collections", async () => {
    const mockUtils = createMockTrpcUtils();
    await refreshGlobalCounts(mockUtils.utils, null);
    // No fetch operations should have been issued
    expect(mockUtils.operations).toHaveLength(0);
  });
});

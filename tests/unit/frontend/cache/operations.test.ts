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
  handleEntriesMarkedRead,
  handleEntryStarred,
  handleEntryUnstarred,
  handleNewEntry,
  handleSubscriptionCreated,
  handleSubscriptionDeleted,
  type EntryWithContext,
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

describe("handleEntriesMarkedRead", () => {
  let mockUtils: ReturnType<typeof createMockTrpcUtils>;

  beforeEach(() => {
    _resetSubscriptionLookupMap();
    mockUtils = createMockTrpcUtils();
  });

  it("does nothing for empty entries array", () => {
    handleEntriesMarkedRead(mockUtils.utils, [], true);
    expect(mockUtils.operations).toHaveLength(0);
  });

  it("updates entry read status in entries.get cache", () => {
    const entries: EntryWithContext[] = [
      { id: "entry-1", subscriptionId: "sub-1", starred: false, type: "web" },
    ];

    handleEntriesMarkedRead(mockUtils.utils, entries, true);

    const setDataOps = mockUtils.operations.filter(
      (op) => op.type === "setData" && op.router === "entries" && op.procedure === "get"
    );
    expect(setDataOps.length).toBeGreaterThan(0);
  });

  it("updates subscription unread counts in lookup map", () => {
    seedSubscription({ id: "sub-1", unreadCount: 5, tags: [] });
    seedSubscription({ id: "sub-2", unreadCount: 3, tags: [] });

    const entries: EntryWithContext[] = [
      { id: "entry-1", subscriptionId: "sub-1", starred: false, type: "web" },
      { id: "entry-2", subscriptionId: "sub-1", starred: false, type: "web" },
      { id: "entry-3", subscriptionId: "sub-2", starred: false, type: "web" },
    ];

    handleEntriesMarkedRead(mockUtils.utils, entries, true);

    expect(getSubscriptionFromMap("sub-1")?.unreadCount).toBe(3);
    expect(getSubscriptionFromMap("sub-2")?.unreadCount).toBe(2);
  });

  it("updates starred unread count for starred entries", () => {
    const entries: EntryWithContext[] = [
      { id: "entry-1", subscriptionId: "sub-1", starred: true, type: "web" },
      { id: "entry-2", subscriptionId: "sub-1", starred: false, type: "web" },
    ];

    handleEntriesMarkedRead(mockUtils.utils, entries, true);

    // Should have called setData on entries.count with starredOnly filter
    const countOps = mockUtils.operations.filter(
      (op) => op.type === "setData" && op.router === "entries" && op.procedure === "count"
    );
    expect(countOps.length).toBeGreaterThan(0);
  });

  it("updates saved unread count for saved entries", () => {
    const entries: EntryWithContext[] = [
      { id: "entry-1", subscriptionId: "sub-1", starred: false, type: "saved" },
    ];

    handleEntriesMarkedRead(mockUtils.utils, entries, true);

    // Should have called setData on entries.count with type: "saved" filter
    const countOps = mockUtils.operations.filter(
      (op) => op.type === "setData" && op.router === "entries" && op.procedure === "count"
    );
    expect(countOps.length).toBeGreaterThan(0);
  });

  it("handles entries without subscription (saved articles)", () => {
    const entries: EntryWithContext[] = [
      { id: "entry-1", subscriptionId: null, starred: false, type: "saved" },
    ];

    // Should not throw
    handleEntriesMarkedRead(mockUtils.utils, entries, true);

    // Should still update entries.get
    const entryOps = mockUtils.operations.filter((op) => op.router === "entries");
    expect(entryOps.length).toBeGreaterThan(0);
  });
});

describe("handleEntryStarred", () => {
  let mockUtils: ReturnType<typeof createMockTrpcUtils>;

  beforeEach(() => {
    _resetSubscriptionLookupMap();
    mockUtils = createMockTrpcUtils();
  });

  it("updates entry starred status", () => {
    handleEntryStarred(mockUtils.utils, "entry-1", false);

    const entryOps = mockUtils.operations.filter(
      (op) => op.type === "setData" && op.router === "entries" && op.procedure === "get"
    );
    expect(entryOps.length).toBeGreaterThan(0);
  });

  it("updates starred unread count +1 for unread entry", () => {
    handleEntryStarred(mockUtils.utils, "entry-1", false); // unread entry

    // The unread delta should be +1
    const countOps = mockUtils.operations.filter(
      (op) => op.type === "setData" && op.router === "entries" && op.procedure === "count"
    );
    expect(countOps.length).toBeGreaterThan(0);
  });

  it("does not change starred unread count for read entry", () => {
    handleEntryStarred(mockUtils.utils, "entry-1", true); // read entry

    // No count update since only unread counts are tracked and the entry is read
    const countOps = mockUtils.operations.filter(
      (op) => op.type === "setData" && op.router === "entries" && op.procedure === "count"
    );
    expect(countOps.length).toBe(0);
  });
});

describe("handleEntryUnstarred", () => {
  let mockUtils: ReturnType<typeof createMockTrpcUtils>;

  beforeEach(() => {
    _resetSubscriptionLookupMap();
    mockUtils = createMockTrpcUtils();
  });

  it("updates entry starred status to false", () => {
    handleEntryUnstarred(mockUtils.utils, "entry-1", false);

    const entryOps = mockUtils.operations.filter(
      (op) => op.type === "setData" && op.router === "entries" && op.procedure === "get"
    );
    expect(entryOps.length).toBeGreaterThan(0);
  });

  it("does not change starred unread count for read entry", () => {
    handleEntryUnstarred(mockUtils.utils, "entry-1", true); // read entry

    // No count update since only unread counts are tracked and the entry is read
    const countOps = mockUtils.operations.filter(
      (op) => op.type === "setData" && op.router === "entries" && op.procedure === "count"
    );
    expect(countOps.length).toBe(0);
  });

  it("updates starred unread count -1 for unread entry", () => {
    handleEntryUnstarred(mockUtils.utils, "entry-1", false); // unread entry

    // The unread delta should be -1
    const countOps = mockUtils.operations.filter(
      (op) => op.type === "setData" && op.router === "entries" && op.procedure === "count"
    );
    expect(countOps.length).toBeGreaterThan(0);
  });
});

describe("handleNewEntry", () => {
  let mockUtils: ReturnType<typeof createMockTrpcUtils>;

  beforeEach(() => {
    _resetSubscriptionLookupMap();
    mockUtils = createMockTrpcUtils();
  });

  it("increments subscription unread count in lookup map", () => {
    seedSubscription({ id: "sub-1", unreadCount: 5, tags: [] });

    handleNewEntry(mockUtils.utils, "sub-1", "web");

    expect(getSubscriptionFromMap("sub-1")?.unreadCount).toBe(6);
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

describe("cache update logic verification", () => {
  let mockUtils: ReturnType<typeof createMockTrpcUtils>;

  beforeEach(() => {
    _resetSubscriptionLookupMap();
    mockUtils = createMockTrpcUtils();
  });

  describe("handleEntriesMarkedRead cache state updates", () => {
    it("decrements unread count when marking entries as read", () => {
      seedSubscription({ id: "sub-1", unreadCount: 5, tags: [] });

      const entries: EntryWithContext[] = [
        { id: "entry-1", subscriptionId: "sub-1", starred: false, type: "web" },
        { id: "entry-2", subscriptionId: "sub-1", starred: false, type: "web" },
      ];

      handleEntriesMarkedRead(mockUtils.utils, entries, true);

      expect(getSubscriptionFromMap("sub-1")?.unreadCount).toBe(3);
    });

    it("increments unread count when marking entries as unread", () => {
      seedSubscription({ id: "sub-1", unreadCount: 3, tags: [] });

      const entries: EntryWithContext[] = [
        { id: "entry-1", subscriptionId: "sub-1", starred: false, type: "web" },
      ];

      handleEntriesMarkedRead(mockUtils.utils, entries, false);

      expect(getSubscriptionFromMap("sub-1")?.unreadCount).toBe(4);
    });

    it("updates multiple subscriptions independently", () => {
      seedSubscription({ id: "sub-1", unreadCount: 10, tags: [] });
      seedSubscription({ id: "sub-2", unreadCount: 5, tags: [] });

      const entries: EntryWithContext[] = [
        { id: "entry-1", subscriptionId: "sub-1", starred: false, type: "web" },
        { id: "entry-2", subscriptionId: "sub-1", starred: false, type: "web" },
        { id: "entry-3", subscriptionId: "sub-2", starred: false, type: "web" },
      ];

      handleEntriesMarkedRead(mockUtils.utils, entries, true);

      expect(getSubscriptionFromMap("sub-1")?.unreadCount).toBe(8); // 10 - 2
      expect(getSubscriptionFromMap("sub-2")?.unreadCount).toBe(4); // 5 - 1
    });

    it("does not decrement unread count below zero", () => {
      seedSubscription({ id: "sub-1", unreadCount: 1, tags: [] });

      const entries: EntryWithContext[] = [
        { id: "entry-1", subscriptionId: "sub-1", starred: false, type: "web" },
        { id: "entry-2", subscriptionId: "sub-1", starred: false, type: "web" },
        { id: "entry-3", subscriptionId: "sub-1", starred: false, type: "web" },
      ];

      handleEntriesMarkedRead(mockUtils.utils, entries, true);

      expect(getSubscriptionFromMap("sub-1")?.unreadCount).toBe(0); // Clamped to 0
    });

    it("updates tag unread counts based on subscription tags", () => {
      seedSubscription({
        id: "sub-1",
        unreadCount: 5,
        tags: [{ id: "tag-1", name: "News", color: null }],
      });
      mockUtils.setCache("tags", "list", undefined, {
        items: [{ id: "tag-1", name: "News", color: null, unreadCount: 10 }],
      });

      const entries: EntryWithContext[] = [
        { id: "entry-1", subscriptionId: "sub-1", starred: false, type: "web" },
      ];

      handleEntriesMarkedRead(mockUtils.utils, entries, true);

      const tagData = mockUtils.getCache("tags", "list", undefined) as {
        items: Array<{ id: string; unreadCount: number }>;
      };
      expect(tagData.items[0].unreadCount).toBe(9);
    });
  });

  describe("handleNewEntry cache state updates", () => {
    it("increments subscription unread count", () => {
      seedSubscription({ id: "sub-1", unreadCount: 5, tags: [] });

      handleNewEntry(mockUtils.utils, "sub-1", "web");

      expect(getSubscriptionFromMap("sub-1")?.unreadCount).toBe(6);
    });

    it("increments tag unread count for subscription with tags", () => {
      seedSubscription({
        id: "sub-1",
        unreadCount: 5,
        tags: [{ id: "tag-1", name: "News", color: null }],
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

  describe("handleEntryStarred cache state updates", () => {
    it("increments starred unread count for unread entry", () => {
      mockUtils.setCache("entries", "count", { starredOnly: true }, { unread: 2 });

      handleEntryStarred(mockUtils.utils, "entry-1", false); // unread entry

      const countData = mockUtils.getCache("entries", "count", { starredOnly: true }) as {
        unread: number;
      };
      expect(countData.unread).toBe(3); // +1
    });

    it("does not change starred unread count for read entry", () => {
      mockUtils.setCache("entries", "count", { starredOnly: true }, { unread: 2 });

      handleEntryStarred(mockUtils.utils, "entry-1", true); // read entry

      const countData = mockUtils.getCache("entries", "count", { starredOnly: true }) as {
        unread: number;
      };
      expect(countData.unread).toBe(2); // unchanged
    });
  });

  describe("handleEntryUnstarred cache state updates", () => {
    it("decrements starred unread count for unread entry", () => {
      mockUtils.setCache("entries", "count", { starredOnly: true }, { unread: 2 });

      handleEntryUnstarred(mockUtils.utils, "entry-1", false); // unread entry

      const countData = mockUtils.getCache("entries", "count", { starredOnly: true }) as {
        unread: number;
      };
      expect(countData.unread).toBe(1); // -1
    });

    it("does not change starred unread count for read entry", () => {
      mockUtils.setCache("entries", "count", { starredOnly: true }, { unread: 2 });

      handleEntryUnstarred(mockUtils.utils, "entry-1", true); // read entry

      const countData = mockUtils.getCache("entries", "count", { starredOnly: true }) as {
        unread: number;
      };
      expect(countData.unread).toBe(2); // unchanged
    });

    it("does not decrement below zero", () => {
      mockUtils.setCache("entries", "count", { starredOnly: true }, { unread: 0 });

      handleEntryUnstarred(mockUtils.utils, "entry-1", false); // unread entry

      const countData = mockUtils.getCache("entries", "count", { starredOnly: true }) as {
        unread: number;
      };
      expect(countData.unread).toBe(0); // clamped
    });
  });
});

describe("edge cases", () => {
  let mockUtils: ReturnType<typeof createMockTrpcUtils>;

  beforeEach(() => {
    _resetSubscriptionLookupMap();
    mockUtils = createMockTrpcUtils();
  });

  describe("null/undefined handling", () => {
    it("handleEntriesMarkedRead handles entries with null subscriptionId", () => {
      const entries: EntryWithContext[] = [
        { id: "entry-1", subscriptionId: null, starred: false, type: "saved" },
        { id: "entry-2", subscriptionId: null, starred: true, type: "saved" },
      ];

      // Should not throw
      handleEntriesMarkedRead(mockUtils.utils, entries, true);

      // Should still update entries.get
      const entryOps = mockUtils.operations.filter(
        (op) => op.type === "setData" && op.router === "entries" && op.procedure === "get"
      );
      expect(entryOps.length).toBeGreaterThan(0);
    });

    it("handleEntriesMarkedRead handles mixed null and non-null subscriptionIds", () => {
      seedSubscription({ id: "sub-1", unreadCount: 5, tags: [] });

      const entries: EntryWithContext[] = [
        { id: "entry-1", subscriptionId: "sub-1", starred: false, type: "web" },
        { id: "entry-2", subscriptionId: null, starred: false, type: "saved" },
      ];

      handleEntriesMarkedRead(mockUtils.utils, entries, true);

      // Only sub-1 should be decremented
      expect(getSubscriptionFromMap("sub-1")?.unreadCount).toBe(4);
    });

    it("handleEntriesMarkedRead handles when subscription not in lookup map", () => {
      // Don't seed subscription - leave lookup map empty
      const entries: EntryWithContext[] = [
        { id: "entry-1", subscriptionId: "sub-1", starred: false, type: "web" },
      ];

      // Should not throw
      handleEntriesMarkedRead(mockUtils.utils, entries, true);
    });

    it("handleNewEntry handles when subscription not in lookup map", () => {
      // Don't seed subscription - leave lookup map empty
      // Should not throw
      handleNewEntry(mockUtils.utils, "sub-1", "web");
    });
  });

  describe("empty arrays", () => {
    it("handleEntriesMarkedRead with empty array does nothing", () => {
      handleEntriesMarkedRead(mockUtils.utils, [], true);
      expect(mockUtils.operations).toHaveLength(0);
    });

    it("handleEntriesMarkedRead with empty array does not update subscriptions", () => {
      seedSubscription({ id: "sub-1", unreadCount: 5, tags: [] });

      handleEntriesMarkedRead(mockUtils.utils, [], true);

      expect(getSubscriptionFromMap("sub-1")?.unreadCount).toBe(5); // unchanged
    });
  });

  describe("boundary conditions", () => {
    it("handles very large unread count", () => {
      seedSubscription({ id: "sub-1", unreadCount: 999999, tags: [] });

      const entries: EntryWithContext[] = [
        { id: "entry-1", subscriptionId: "sub-1", starred: false, type: "web" },
      ];

      handleEntriesMarkedRead(mockUtils.utils, entries, true);

      expect(getSubscriptionFromMap("sub-1")?.unreadCount).toBe(999998);
    });

    it("handles many entries being marked at once", () => {
      seedSubscription({ id: "sub-1", unreadCount: 100, tags: [] });

      const entries: EntryWithContext[] = Array.from({ length: 50 }, (_, i) => ({
        id: `entry-${i}`,
        subscriptionId: "sub-1",
        starred: false,
        type: "web" as const,
      }));

      handleEntriesMarkedRead(mockUtils.utils, entries, true);

      expect(getSubscriptionFromMap("sub-1")?.unreadCount).toBe(50);
    });

    it("handles entry belonging to non-existent subscription", () => {
      seedSubscription({ id: "sub-1", unreadCount: 5, tags: [] });

      const entries: EntryWithContext[] = [
        { id: "entry-1", subscriptionId: "non-existent", starred: false, type: "web" },
      ];

      // Should not throw
      handleEntriesMarkedRead(mockUtils.utils, entries, true);

      // sub-1 should be unchanged
      expect(getSubscriptionFromMap("sub-1")?.unreadCount).toBe(5);
    });
  });

  describe("all entry types", () => {
    it("handles web type entries", () => {
      const entries: EntryWithContext[] = [
        { id: "entry-1", subscriptionId: "sub-1", starred: false, type: "web" },
      ];

      handleEntriesMarkedRead(mockUtils.utils, entries, true);

      // Should not update saved count
      const countOps = mockUtils.operations.filter(
        (op) =>
          op.type === "setData" &&
          op.router === "entries" &&
          op.procedure === "count" &&
          JSON.stringify((op.input as { type?: string })?.type) === '"saved"'
      );
      expect(countOps.length).toBe(0);
    });

    it("handles email type entries", () => {
      const entries: EntryWithContext[] = [
        { id: "entry-1", subscriptionId: "sub-1", starred: false, type: "email" },
      ];

      handleEntriesMarkedRead(mockUtils.utils, entries, true);

      // Should not update saved count
      const countOps = mockUtils.operations.filter(
        (op) =>
          op.type === "setData" &&
          op.router === "entries" &&
          op.procedure === "count" &&
          JSON.stringify((op.input as { type?: string })?.type) === '"saved"'
      );
      expect(countOps.length).toBe(0);
    });

    it("handles saved type entries", () => {
      const entries: EntryWithContext[] = [
        { id: "entry-1", subscriptionId: "sub-1", starred: false, type: "saved" },
      ];

      handleEntriesMarkedRead(mockUtils.utils, entries, true);

      // Should update saved count
      const countOps = mockUtils.operations.filter(
        (op) => op.type === "setData" && op.router === "entries" && op.procedure === "count"
      );
      expect(countOps.length).toBeGreaterThan(0);
    });

    it("handles mix of all entry types", () => {
      seedSubscription({ id: "sub-1", unreadCount: 10, tags: [] });
      seedSubscription({ id: "sub-2", unreadCount: 5, tags: [] });
      seedSubscription({ id: "sub-3", unreadCount: 3, tags: [] });

      const entries: EntryWithContext[] = [
        { id: "entry-1", subscriptionId: "sub-1", starred: false, type: "web" },
        { id: "entry-2", subscriptionId: "sub-2", starred: true, type: "email" },
        { id: "entry-3", subscriptionId: "sub-3", starred: false, type: "saved" },
      ];

      handleEntriesMarkedRead(mockUtils.utils, entries, true);

      expect(getSubscriptionFromMap("sub-1")?.unreadCount).toBe(9);
      expect(getSubscriptionFromMap("sub-2")?.unreadCount).toBe(4);
      expect(getSubscriptionFromMap("sub-3")?.unreadCount).toBe(2);
    });
  });
});

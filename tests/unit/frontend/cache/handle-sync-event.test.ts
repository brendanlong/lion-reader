/**
 * Integration tests for handleSyncEvent.
 *
 * Tests the full event → cache-state pipeline by calling handleSyncEvent()
 * with realistic pre-seeded cache state and asserting the resulting cache values.
 *
 * Uses a real QueryClient from @tanstack/react-query for infinite query operations,
 * combined with mock tRPC utils for the standard query cache.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { handleSyncEvent } from "@/lib/cache/event-handlers";
import { _resetSubscriptionLookupMap, getSubscriptionLookupMap } from "@/lib/cache/count-cache";
import { createMockTrpcUtils } from "../../../utils/trpc-mock";
import {
  createSeededQueryClient,
  seedCacheState,
  createNewEntryEvent,
  createEntryUpdatedEvent,
  createEntryStateChangedEvent,
  createSubscriptionCreatedEvent,
  createSubscriptionUpdatedEvent,
  createSubscriptionDeletedEvent,
  createTagCreatedEvent,
  createTagUpdatedEvent,
  createTagDeletedEvent,
  createImportProgressEvent,
  DEFAULT_SUBSCRIPTIONS,
} from "../../../utils/cache-test-helpers";
import type { QueryClient } from "@tanstack/react-query";

// ============================================================================
// Test Setup
// ============================================================================

let mockUtils: ReturnType<typeof createMockTrpcUtils>;
let queryClient: QueryClient;

beforeEach(() => {
  _resetSubscriptionLookupMap();
  mockUtils = createMockTrpcUtils();
  queryClient = createSeededQueryClient();
  seedCacheState(mockUtils);
  mockUtils.clearOperations();
});

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Gets subscriptions from the subscription lookup map (primary source)
 * and falls back to the mock cache for backwards compatibility.
 */
function getSubscriptionsList(): {
  items: Array<{
    id: string;
    unreadCount: number;
    tags: Array<{ id: string }>;
    [key: string]: unknown;
  }>;
} {
  const lookupMap = getSubscriptionLookupMap();
  return {
    items: Array.from(lookupMap.values()) as Array<{
      id: string;
      unreadCount: number;
      tags: Array<{ id: string }>;
      [key: string]: unknown;
    }>,
  };
}

function getTagsList():
  | {
      items: Array<{
        id: string;
        name: string;
        color: string | null;
        feedCount: number;
        unreadCount: number;
        [key: string]: unknown;
      }>;
      uncategorized: { feedCount: number; unreadCount: number };
    }
  | undefined {
  return mockUtils.getCache("tags", "list", undefined) as ReturnType<typeof getTagsList>;
}

function getEntriesCount(filters: Record<string, unknown> = {}): { unread: number } | undefined {
  return mockUtils.getCache("entries", "count", filters) as ReturnType<typeof getEntriesCount>;
}

function getEntryGet(id: string): { entry: Record<string, unknown> } | undefined {
  return mockUtils.getCache("entries", "get", { id }) as ReturnType<typeof getEntryGet>;
}

function getEntriesFromQueryClient(): Array<Record<string, unknown>> {
  const queries = queryClient.getQueriesData<{
    pages: Array<{ items: Array<Record<string, unknown>> }>;
  }>({ queryKey: [["entries", "list"]] });

  const entries: Array<Record<string, unknown>> = [];
  for (const [, data] of queries) {
    if (!data?.pages) continue;
    for (const page of data.pages) {
      entries.push(...page.items);
    }
  }
  return entries;
}

function findEntryInQueryClient(entryId: string): Record<string, unknown> | undefined {
  return getEntriesFromQueryClient().find((e) => e.id === entryId);
}

// ============================================================================
// new_entry Events
// ============================================================================

describe("handleSyncEvent - new_entry", () => {
  it("increments subscription unread count for tagged subscription", () => {
    handleSyncEvent(
      mockUtils.utils,
      queryClient,
      createNewEntryEvent({
        subscriptionId: "sub-1",
        feedType: "web",
      })
    );

    const subs = getSubscriptionsList();
    const sub1 = subs?.items.find((s) => s.id === "sub-1");
    expect(sub1?.unreadCount).toBe(6); // was 5

    const tagsList = getTagsList();
    const tag1 = tagsList?.items.find((t) => t.id === "tag-1");
    expect(tag1?.unreadCount).toBe(16); // was 15, sub-1 is in tag-1

    expect(getEntriesCount({})?.unread).toBe(19); // was 18
    expect(getEntriesCount({ type: "saved" })?.unread).toBe(1); // unchanged
  });

  it("increments saved count for saved entry (null subscriptionId)", () => {
    handleSyncEvent(
      mockUtils.utils,
      queryClient,
      createNewEntryEvent({
        subscriptionId: null,
        feedType: "saved",
      })
    );

    expect(getEntriesCount({})?.unread).toBe(19); // +1
    expect(getEntriesCount({ type: "saved" })?.unread).toBe(2); // +1

    // No subscription changes
    const subs = getSubscriptionsList();
    expect(subs?.items.find((s) => s.id === "sub-1")?.unreadCount).toBe(5);
  });

  it("increments uncategorized unread for untagged subscription", () => {
    handleSyncEvent(
      mockUtils.utils,
      queryClient,
      createNewEntryEvent({
        subscriptionId: "sub-2", // sub-2 has no tags
        feedType: "web",
      })
    );

    const subs = getSubscriptionsList();
    expect(subs?.items.find((s) => s.id === "sub-2")?.unreadCount).toBe(4); // was 3

    const tagsList = getTagsList();
    expect(tagsList?.uncategorized.unreadCount).toBe(4); // was 3
  });

  it("increments both tags for subscription with 2 tags", () => {
    handleSyncEvent(
      mockUtils.utils,
      queryClient,
      createNewEntryEvent({
        subscriptionId: "sub-3", // sub-3 has tag-1 and tag-2
        feedType: "web",
      })
    );

    const subs = getSubscriptionsList();
    expect(subs?.items.find((s) => s.id === "sub-3")?.unreadCount).toBe(11); // was 10

    const tagsList = getTagsList();
    expect(tagsList?.items.find((t) => t.id === "tag-1")?.unreadCount).toBe(16); // +1
    expect(tagsList?.items.find((t) => t.id === "tag-2")?.unreadCount).toBe(11); // +1
  });

  it("updates counts for email feed type", () => {
    handleSyncEvent(
      mockUtils.utils,
      queryClient,
      createNewEntryEvent({
        subscriptionId: "sub-1",
        feedType: "email",
      })
    );

    const subs = getSubscriptionsList();
    expect(subs?.items.find((s) => s.id === "sub-1")?.unreadCount).toBe(6);
    expect(getEntriesCount({})?.unread).toBe(19);
  });
});

// ============================================================================
// entry_updated Events
// ============================================================================

describe("handleSyncEvent - entry_updated", () => {
  it("updates metadata in entries.get cache", () => {
    handleSyncEvent(
      mockUtils.utils,
      queryClient,
      createEntryUpdatedEvent({
        entryId: "entry-1",
        metadata: {
          title: "New Title",
          author: "New Author",
          summary: "New Summary",
          url: "https://example.com/new-url",
          publishedAt: "2024-08-01T00:00:00.000Z",
        },
      })
    );

    const cached = getEntryGet("entry-1");
    expect(cached?.entry.title).toBe("New Title");
    expect(cached?.entry.author).toBe("New Author");
    expect(cached?.entry.summary).toBe("New Summary");
    expect(cached?.entry.url).toBe("https://example.com/new-url");
    expect(cached?.entry.publishedAt).toEqual(new Date("2024-08-01T00:00:00.000Z"));
  });

  it("updates metadata in entries.list cache (QueryClient)", () => {
    handleSyncEvent(
      mockUtils.utils,
      queryClient,
      createEntryUpdatedEvent({
        entryId: "entry-1",
        metadata: {
          title: "New Title",
          author: "New Author",
          summary: "New Summary",
          url: "https://example.com/new-url",
          publishedAt: "2024-08-01T00:00:00.000Z",
        },
      })
    );

    const entry = findEntryInQueryClient("entry-1");
    expect(entry?.title).toBe("New Title");
    expect(entry?.author).toBe("New Author");
    expect(entry?.summary).toBe("New Summary");
    expect(entry?.url).toBe("https://example.com/new-url");
    expect(entry?.publishedAt).toEqual(new Date("2024-08-01T00:00:00.000Z"));
  });

  it("handles null publishedAt", () => {
    handleSyncEvent(
      mockUtils.utils,
      queryClient,
      createEntryUpdatedEvent({
        entryId: "entry-1",
        metadata: {
          title: "Updated",
          author: null,
          summary: null,
          url: null,
          publishedAt: null,
        },
      })
    );

    const cached = getEntryGet("entry-1");
    expect(cached?.entry.publishedAt).toBeNull();
  });

  it("does not crash for non-cached entry", () => {
    expect(() => {
      handleSyncEvent(
        mockUtils.utils,
        queryClient,
        createEntryUpdatedEvent({
          entryId: "non-existent-entry",
        })
      );
    }).not.toThrow();

    // Original cache unchanged
    const cached = getEntryGet("entry-1");
    expect(cached?.entry.title).toBe("Old Title");
  });
});

// ============================================================================
// entry_state_changed Events
// ============================================================================

describe("handleSyncEvent - entry_state_changed", () => {
  it("updates read status in entries.list", () => {
    handleSyncEvent(
      mockUtils.utils,
      queryClient,
      createEntryStateChangedEvent({
        entryId: "entry-1",
        read: true,
        starred: true,
      })
    );

    const entry = findEntryInQueryClient("entry-1");
    expect(entry?.read).toBe(true);
    expect(entry?.starred).toBe(true);
  });

  it("updates starred status in entries.list", () => {
    handleSyncEvent(
      mockUtils.utils,
      queryClient,
      createEntryStateChangedEvent({
        entryId: "entry-2",
        read: false,
        starred: true,
      })
    );

    const entry = findEntryInQueryClient("entry-2");
    expect(entry?.starred).toBe(true);
    expect(entry?.read).toBe(false);
  });

  it("updates entries.get for cached entry", () => {
    handleSyncEvent(
      mockUtils.utils,
      queryClient,
      createEntryStateChangedEvent({
        entryId: "entry-1",
        read: true,
        starred: false,
      })
    );

    const cached = getEntryGet("entry-1");
    expect(cached?.entry.read).toBe(true);
    expect(cached?.entry.starred).toBe(false);
  });

  it("does not crash for non-cached entry", () => {
    expect(() => {
      handleSyncEvent(
        mockUtils.utils,
        queryClient,
        createEntryStateChangedEvent({
          entryId: "non-existent-entry",
          read: true,
          starred: false,
        })
      );
    }).not.toThrow();
  });
});

// ============================================================================
// subscription_created Events
// ============================================================================

describe("handleSyncEvent - subscription_created", () => {
  it("adds subscription with tags and updates counts", () => {
    handleSyncEvent(
      mockUtils.utils,
      queryClient,
      createSubscriptionCreatedEvent({
        subscription: {
          id: "sub-new",
          feedId: "feed-new",
          customTitle: null,
          subscribedAt: "2024-07-01T00:00:00.000Z",
          unreadCount: 7,
          tags: [{ id: "tag-1", name: "Tech", color: "#ff0000" }],
        },
        feed: {
          id: "feed-new",
          type: "web",
          url: "https://example.com/new.xml",
          title: "New Feed",
          description: null,
          siteUrl: null,
        },
      })
    );

    const subs = getSubscriptionsList();
    const newSub = subs?.items.find((s) => s.id === "sub-new");
    expect(newSub).toBeDefined();
    expect(newSub?.unreadCount).toBe(7);

    const tagsList = getTagsList();
    const tag1 = tagsList?.items.find((t) => t.id === "tag-1");
    expect(tag1?.feedCount).toBe(3); // was 2
    expect(tag1?.unreadCount).toBe(22); // was 15, +7

    expect(getEntriesCount({})?.unread).toBe(25); // was 18, +7
  });

  it("adds uncategorized subscription and updates uncategorized counts", () => {
    handleSyncEvent(
      mockUtils.utils,
      queryClient,
      createSubscriptionCreatedEvent({
        subscription: {
          id: "sub-new",
          feedId: "feed-new",
          customTitle: null,
          subscribedAt: "2024-07-01T00:00:00.000Z",
          unreadCount: 3,
          tags: [],
        },
        feed: {
          id: "feed-new",
          type: "web",
          url: "https://example.com/new.xml",
          title: "Uncat Feed",
          description: null,
          siteUrl: null,
        },
      })
    );

    const tagsList = getTagsList();
    expect(tagsList?.uncategorized.feedCount).toBe(2); // was 1
    expect(tagsList?.uncategorized.unreadCount).toBe(6); // was 3, +3

    expect(getEntriesCount({})?.unread).toBe(21); // was 18, +3
  });

  it("does not cause count inflation for duplicate events", () => {
    const event = createSubscriptionCreatedEvent();

    handleSyncEvent(mockUtils.utils, queryClient, event);
    const countAfterFirst = getEntriesCount({})?.unread;

    handleSyncEvent(mockUtils.utils, queryClient, event);
    const countAfterSecond = getEntriesCount({})?.unread;

    expect(countAfterSecond).toBe(countAfterFirst);
  });

  it("uses customTitle when provided", () => {
    handleSyncEvent(
      mockUtils.utils,
      queryClient,
      createSubscriptionCreatedEvent({
        subscription: {
          id: "sub-new",
          feedId: "feed-new",
          customTitle: "My Custom Title",
          subscribedAt: "2024-07-01T00:00:00.000Z",
          unreadCount: 0,
          tags: [],
        },
        feed: {
          id: "feed-new",
          type: "web",
          url: "https://example.com/new.xml",
          title: "Original Feed Title",
          description: null,
          siteUrl: null,
        },
      })
    );

    const subs = getSubscriptionsList();
    const newSub = subs?.items.find((s) => s.id === "sub-new");
    expect((newSub as Record<string, unknown>)?.title).toBe("My Custom Title");
  });
});

// ============================================================================
// subscription_updated Events
// ============================================================================

describe("handleSyncEvent - subscription_updated", () => {
  it("updates tags on subscription", () => {
    handleSyncEvent(
      mockUtils.utils,
      queryClient,
      createSubscriptionUpdatedEvent({
        subscriptionId: "sub-1",
        tags: [{ id: "tag-2", name: "Science", color: "#00ff00" }],
        customTitle: null,
      })
    );

    const subs = getSubscriptionsList();
    const sub1 = subs?.items.find((s) => s.id === "sub-1");
    expect(sub1?.tags).toEqual([{ id: "tag-2", name: "Science", color: "#00ff00" }]);
  });

  it("sets customTitle when provided", () => {
    handleSyncEvent(
      mockUtils.utils,
      queryClient,
      createSubscriptionUpdatedEvent({
        subscriptionId: "sub-1",
        tags: [{ id: "tag-1", name: "Tech", color: "#ff0000" }],
        customTitle: "Custom Name",
      })
    );

    const subs = getSubscriptionsList();
    const sub1 = subs?.items.find((s) => s.id === "sub-1");
    expect((sub1 as Record<string, unknown>)?.title).toBe("Custom Name");
  });

  it("reverts to originalTitle when customTitle is cleared", () => {
    // First seed subscriptions.get with originalTitle
    mockUtils.setCache(
      "subscriptions",
      "get",
      { id: "sub-1" },
      {
        ...DEFAULT_SUBSCRIPTIONS[0],
        originalTitle: "Feed One Original",
      }
    );

    handleSyncEvent(
      mockUtils.utils,
      queryClient,
      createSubscriptionUpdatedEvent({
        subscriptionId: "sub-1",
        tags: [{ id: "tag-1", name: "Tech", color: "#ff0000" }],
        customTitle: null,
      })
    );

    const subs = getSubscriptionsList();
    const sub1 = subs?.items.find((s) => s.id === "sub-1");
    expect((sub1 as Record<string, unknown>)?.title).toBe("Feed One Original");
  });

  it("invalidates tags.list and subscriptions.list", () => {
    mockUtils.clearOperations();
    handleSyncEvent(mockUtils.utils, queryClient, createSubscriptionUpdatedEvent());

    const invalidations = mockUtils.operations.filter((op) => op.type === "invalidate");
    expect(invalidations.some((op) => op.router === "tags" && op.procedure === "list")).toBe(true);
    expect(
      invalidations.some((op) => op.router === "subscriptions" && op.procedure === "list")
    ).toBe(true);
  });
});

// ============================================================================
// subscription_deleted Events
// ============================================================================

describe("handleSyncEvent - subscription_deleted", () => {
  it("removes subscription with tags and updates counts", () => {
    handleSyncEvent(
      mockUtils.utils,
      queryClient,
      createSubscriptionDeletedEvent({
        subscriptionId: "sub-1",
      })
    );

    const subs = getSubscriptionsList();
    expect(subs?.items.find((s) => s.id === "sub-1")).toBeUndefined();

    const tagsList = getTagsList();
    const tag1 = tagsList?.items.find((t) => t.id === "tag-1");
    expect(tag1?.feedCount).toBe(1); // was 2
    expect(tag1?.unreadCount).toBe(10); // was 15, -5

    expect(getEntriesCount({})?.unread).toBe(13); // was 18, -5
  });

  it("removes uncategorized subscription and updates uncategorized counts", () => {
    handleSyncEvent(
      mockUtils.utils,
      queryClient,
      createSubscriptionDeletedEvent({
        subscriptionId: "sub-2", // sub-2 has no tags, unreadCount=3
      })
    );

    const subs = getSubscriptionsList();
    expect(subs?.items.find((s) => s.id === "sub-2")).toBeUndefined();

    const tagsList = getTagsList();
    expect(tagsList?.uncategorized.feedCount).toBe(0); // was 1
    expect(tagsList?.uncategorized.unreadCount).toBe(0); // was 3, -3

    expect(getEntriesCount({})?.unread).toBe(15); // was 18, -3
  });

  it("is a no-op when subscription already removed (optimistic update)", () => {
    // First remove it
    handleSyncEvent(
      mockUtils.utils,
      queryClient,
      createSubscriptionDeletedEvent({
        subscriptionId: "sub-1",
      })
    );

    const countAfterFirst = getEntriesCount({})?.unread;

    // Second delete should be a no-op (alreadyRemoved check)
    handleSyncEvent(
      mockUtils.utils,
      queryClient,
      createSubscriptionDeletedEvent({
        subscriptionId: "sub-1",
      })
    );

    expect(getEntriesCount({})?.unread).toBe(countAfterFirst);
  });

  it("is a no-op when subscription not in lookup map (treated as already removed)", () => {
    // When the subscription is not in the lookup map, the handler treats it as
    // "already removed" (optimistic update from same tab) and skips processing.
    mockUtils.clearOperations();
    handleSyncEvent(
      mockUtils.utils,
      queryClient,
      createSubscriptionDeletedEvent({
        subscriptionId: "sub-unknown",
      })
    );

    // No invalidations should occur (the alreadyRemoved check returns true)
    const invalidations = mockUtils.operations.filter((op) => op.type === "invalidate");
    expect(invalidations).toHaveLength(0);
  });
});

// ============================================================================
// tag_created Events
// ============================================================================

describe("handleSyncEvent - tag_created", () => {
  it("adds new tag with zero counts", () => {
    handleSyncEvent(
      mockUtils.utils,
      queryClient,
      createTagCreatedEvent({
        tag: { id: "tag-new", name: "New Tag", color: "#0000ff" },
      })
    );

    const tagsList = getTagsList();
    const newTag = tagsList?.items.find((t) => t.id === "tag-new");
    expect(newTag).toBeDefined();
    expect(newTag?.name).toBe("New Tag");
    expect(newTag?.color).toBe("#0000ff");
    expect(newTag?.feedCount).toBe(0);
    expect(newTag?.unreadCount).toBe(0);
  });

  it("does not create duplicate tag", () => {
    const event = createTagCreatedEvent({
      tag: { id: "tag-1", name: "Tech Duplicate", color: "#ff0000" },
    });

    handleSyncEvent(mockUtils.utils, queryClient, event);

    const tagsList = getTagsList();
    const techTags = tagsList?.items.filter((t) => t.id === "tag-1");
    expect(techTags?.length).toBe(1);
    // Name should NOT be overwritten by duplicate create event
    expect(techTags?.[0]?.name).toBe("Tech");
  });
});

// ============================================================================
// tag_updated Events
// ============================================================================

describe("handleSyncEvent - tag_updated", () => {
  it("updates name and color, preserves counts", () => {
    handleSyncEvent(
      mockUtils.utils,
      queryClient,
      createTagUpdatedEvent({
        tag: { id: "tag-1", name: "Technology", color: "#ff00ff" },
      })
    );

    const tagsList = getTagsList();
    const tag1 = tagsList?.items.find((t) => t.id === "tag-1");
    expect(tag1?.name).toBe("Technology");
    expect(tag1?.color).toBe("#ff00ff");
    expect(tag1?.feedCount).toBe(2); // preserved
    expect(tag1?.unreadCount).toBe(15); // preserved
  });
});

// ============================================================================
// tag_deleted Events
// ============================================================================

describe("handleSyncEvent - tag_deleted", () => {
  it("removes tag from tags.list", () => {
    handleSyncEvent(
      mockUtils.utils,
      queryClient,
      createTagDeletedEvent({
        tagId: "tag-1",
      })
    );

    const tagsList = getTagsList();
    expect(tagsList?.items.find((t) => t.id === "tag-1")).toBeUndefined();
    // tag-2 should remain
    expect(tagsList?.items.find((t) => t.id === "tag-2")).toBeDefined();
  });
});

// ============================================================================
// import_progress Events
// ============================================================================

describe("handleSyncEvent - import_progress", () => {
  it("invalidates imports.get and imports.list", () => {
    mockUtils.clearOperations();
    handleSyncEvent(
      mockUtils.utils,
      queryClient,
      createImportProgressEvent({
        importId: "import-1",
      })
    );

    const invalidations = mockUtils.operations.filter((op) => op.type === "invalidate");
    expect(
      invalidations.some(
        (op) =>
          op.router === "imports" &&
          op.procedure === "get" &&
          JSON.stringify(op.input) === JSON.stringify({ id: "import-1" })
      )
    ).toBe(true);
    expect(invalidations.some((op) => op.router === "imports" && op.procedure === "list")).toBe(
      true
    );
  });
});

// ============================================================================
// import_completed Events
// ============================================================================

describe("handleSyncEvent - import_completed", () => {
  it("invalidates imports.get and imports.list", () => {
    mockUtils.clearOperations();
    handleSyncEvent(mockUtils.utils, queryClient, {
      type: "import_completed",
      importId: "import-2",
      imported: 10,
      skipped: 2,
      failed: 1,
      total: 13,
      timestamp: "2024-07-01T00:00:00.000Z",
      updatedAt: "2024-07-01T00:00:00.000Z",
    });

    const invalidations = mockUtils.operations.filter((op) => op.type === "invalidate");
    expect(
      invalidations.some(
        (op) =>
          op.router === "imports" &&
          op.procedure === "get" &&
          JSON.stringify(op.input) === JSON.stringify({ id: "import-2" })
      )
    ).toBe(true);
    expect(invalidations.some((op) => op.router === "imports" && op.procedure === "list")).toBe(
      true
    );
  });
});

// ============================================================================
// Event Sequences
// ============================================================================

describe("handleSyncEvent - event sequences", () => {
  it("new_entry then entry_state_changed(read): count stays incremented", () => {
    // New entry arrives - sub-1 unread goes from 5 to 6
    handleSyncEvent(
      mockUtils.utils,
      queryClient,
      createNewEntryEvent({
        subscriptionId: "sub-1",
        entryId: "new-entry-seq",
        feedType: "web",
      })
    );

    const subsAfterNew = getSubscriptionsList();
    expect(subsAfterNew?.items.find((s) => s.id === "sub-1")?.unreadCount).toBe(6);
    expect(getEntriesCount({})?.unread).toBe(19);

    // Then the entry is marked read via state_changed from another tab.
    // entry_state_changed does NOT update counts (by design for cross-tab sync).
    handleSyncEvent(
      mockUtils.utils,
      queryClient,
      createEntryStateChangedEvent({
        entryId: "new-entry-seq",
        read: true,
        starred: false,
      })
    );

    // Counts remain at +1 since entry_state_changed doesn't adjust counts
    expect(getSubscriptionsList()?.items.find((s) => s.id === "sub-1")?.unreadCount).toBe(6);
    expect(getEntriesCount({})?.unread).toBe(19);
  });

  it("subscription_created then new_entry for it: counts correct from both", () => {
    // Create a new subscription
    handleSyncEvent(
      mockUtils.utils,
      queryClient,
      createSubscriptionCreatedEvent({
        subscription: {
          id: "sub-seq",
          feedId: "feed-seq",
          customTitle: null,
          subscribedAt: "2024-07-01T00:00:00.000Z",
          unreadCount: 2,
          tags: [{ id: "tag-2", name: "Science", color: "#00ff00" }],
        },
        feed: {
          id: "feed-seq",
          type: "web",
          url: "https://example.com/seq.xml",
          title: "Seq Feed",
          description: null,
          siteUrl: null,
        },
      })
    );

    expect(getEntriesCount({})?.unread).toBe(20); // 18 + 2

    // Now a new entry arrives for that subscription
    handleSyncEvent(
      mockUtils.utils,
      queryClient,
      createNewEntryEvent({
        subscriptionId: "sub-seq",
        feedType: "web",
      })
    );

    expect(getEntriesCount({})?.unread).toBe(21); // 20 + 1

    const subs = getSubscriptionsList();
    expect(subs?.items.find((s) => s.id === "sub-seq")?.unreadCount).toBe(3); // 2 + 1

    const tagsList = getTagsList();
    const tag2 = tagsList?.items.find((t) => t.id === "tag-2");
    expect(tag2?.unreadCount).toBe(13); // was 10, +2 from sub, +1 from entry
  });

  it("subscription_created then subscription_deleted: clean slate", () => {
    handleSyncEvent(
      mockUtils.utils,
      queryClient,
      createSubscriptionCreatedEvent({
        subscription: {
          id: "sub-temp",
          feedId: "feed-temp",
          customTitle: null,
          subscribedAt: "2024-07-01T00:00:00.000Z",
          unreadCount: 5,
          tags: [],
        },
        feed: {
          id: "feed-temp",
          type: "web",
          url: "https://example.com/temp.xml",
          title: "Temp Feed",
          description: null,
          siteUrl: null,
        },
      })
    );

    expect(getEntriesCount({})?.unread).toBe(23); // 18 + 5

    handleSyncEvent(
      mockUtils.utils,
      queryClient,
      createSubscriptionDeletedEvent({
        subscriptionId: "sub-temp",
      })
    );

    const subs = getSubscriptionsList();
    expect(subs?.items.find((s) => s.id === "sub-temp")).toBeUndefined();
    expect(getEntriesCount({})?.unread).toBe(18); // back to original
  });
});

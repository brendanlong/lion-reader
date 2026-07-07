/**
 * Integration tests for handleSyncEvent.
 *
 * Tests the full event → cache-state pipeline by calling handleSyncEvent()
 * with realistic pre-seeded cache state and asserting the resulting cache values.
 *
 * Uses a real QueryClient and real tRPC query utils (createRealTrpcUtils) so the
 * cache helpers run against genuine React Query key hashing, not a fake.
 */

import { describe, it, expect, beforeEach, type MockInstance } from "vitest";
import { handleSyncEvent } from "@/lib/cache/event-handlers";
import { _resetSubscriptionLookupMap, getSubscriptionLookupMap } from "@/lib/cache/count-cache";
import type { TRPCClientUtils } from "@/lib/trpc/client";
import {
  createSeededQueryClient,
  createRealTrpcUtils,
  spyOnInvalidate,
  invalidatedProcedures,
  invalidatedQueries,
  getUtilsData,
  setUtilsData,
  seedCacheState,
  createNewEntryEvent,
  createEntryUpdatedEvent,
  createEntryStateChangedEvent,
  createMarkAllReadEvent,
  createSubscriptionCreatedEvent,
  createSubscriptionUpdatedEvent,
  createSubscriptionDeletedEvent,
  createTagCreatedEvent,
  createTagUpdatedEvent,
  createTagDeletedEvent,
  createImportProgressEvent,
  DEFAULT_SUBSCRIPTIONS,
  DEFAULT_ENTRIES,
} from "../../../utils/cache-test-helpers";
import type { QueryClient } from "@tanstack/react-query";

// ============================================================================
// Test Setup
// ============================================================================

let utils: TRPCClientUtils;
let queryClient: QueryClient;
let invalidateSpy: MockInstance;

beforeEach(() => {
  _resetSubscriptionLookupMap();
  queryClient = createSeededQueryClient();
  utils = createRealTrpcUtils(queryClient);
  seedCacheState(utils);
  // Spy after seeding so only the event-driven invalidations are recorded.
  invalidateSpy = spyOnInvalidate(queryClient);
});

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Gets subscriptions from the subscription lookup map (the primary source read
 * by count calculations and event handlers).
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
  return getUtilsData<ReturnType<typeof getTagsList>>(utils.tags.list);
}

function getEntriesCount(filters: Record<string, unknown> = {}): { unread: number } | undefined {
  return getUtilsData<ReturnType<typeof getEntriesCount>>(utils.entries.count, filters);
}

function getEntryGet(id: string): { entry: Record<string, unknown> } | undefined {
  return getUtilsData<ReturnType<typeof getEntryGet>>(utils.entries.get, { id });
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
  it("sets a tag unread count from event counts even when the subscription is not cached (#892)", () => {
    // Simulates a collapsed sidebar tag: the subscription has never been
    // loaded into any cache, but the server-provided absolute counts include
    // the tag, so tags.list still updates.
    handleSyncEvent(
      utils,
      queryClient,
      createNewEntryEvent({
        subscriptionId: "sub-uncached",
        feedType: "web",
        counts: {
          all: { unread: 19 },
          starred: { unread: 0 },
          subscriptions: [{ id: "sub-uncached", unread: 1 }],
          tags: [{ id: "tag-2", unread: 11 }],
        },
      })
    );

    const tagsList = getTagsList();
    expect(tagsList?.items.find((t) => t.id === "tag-2")?.unreadCount).toBe(11); // set
    expect(tagsList?.items.find((t) => t.id === "tag-1")?.unreadCount).toBe(15); // untouched
    expect(tagsList?.uncategorized.unreadCount).toBe(3); // untouched
    expect(getEntriesCount({})?.unread).toBe(19); // set
  });

  it("sets uncategorized count from event counts when subscription is not cached", () => {
    handleSyncEvent(
      utils,
      queryClient,
      createNewEntryEvent({
        subscriptionId: "sub-uncached",
        feedType: "web",
        counts: {
          all: { unread: 19 },
          starred: { unread: 0 },
          subscriptions: [{ id: "sub-uncached", unread: 1 }],
          tags: [],
          uncategorized: { unread: 4 },
        },
      })
    );

    const tagsList = getTagsList();
    expect(tagsList?.uncategorized.unreadCount).toBe(4); // set
    expect(tagsList?.items.find((t) => t.id === "tag-1")?.unreadCount).toBe(15); // untouched
    expect(tagsList?.items.find((t) => t.id === "tag-2")?.unreadCount).toBe(10); // untouched
  });

  it("sets subscription, tag, and global counts for a tagged subscription", () => {
    handleSyncEvent(
      utils,
      queryClient,
      createNewEntryEvent({
        subscriptionId: "sub-1",
        feedType: "web",
        counts: {
          all: { unread: 19 },
          starred: { unread: 0 },
          subscriptions: [{ id: "sub-1", unread: 6 }],
          tags: [{ id: "tag-1", unread: 16 }],
        },
      })
    );

    const subs = getSubscriptionsList();
    expect(subs?.items.find((s) => s.id === "sub-1")?.unreadCount).toBe(6); // set

    const tagsList = getTagsList();
    expect(tagsList?.items.find((t) => t.id === "tag-1")?.unreadCount).toBe(16); // set

    expect(getEntriesCount({})?.unread).toBe(19); // set
    expect(getEntriesCount({ type: "saved" })?.unread).toBe(1); // saved untouched (web entry)
  });

  it("leaves all counts untouched when the event omits counts (old-server event)", () => {
    handleSyncEvent(
      utils,
      queryClient,
      createNewEntryEvent({
        subscriptionId: "sub-1",
        feedType: "web",
      })
    );

    // No counts on the event → no cache writes; values self-heal on the next
    // count-bearing event or refetch.
    const subs = getSubscriptionsList();
    expect(subs?.items.find((s) => s.id === "sub-1")?.unreadCount).toBe(5); // unchanged
    expect(getEntriesCount({})?.unread).toBe(18); // unchanged
    const tagsList = getTagsList();
    expect(tagsList?.items.find((t) => t.id === "tag-1")?.unreadCount).toBe(15); // unchanged
  });

  it("sets saved count for a saved entry (null subscriptionId)", () => {
    handleSyncEvent(
      utils,
      queryClient,
      createNewEntryEvent({
        subscriptionId: null,
        feedType: "saved",
        counts: {
          all: { unread: 19 },
          starred: { unread: 0 },
          saved: { unread: 2 },
          subscriptions: [],
          tags: [],
        },
      })
    );

    expect(getEntriesCount({})?.unread).toBe(19); // set
    expect(getEntriesCount({ type: "saved" })?.unread).toBe(2); // set

    // No subscription changes
    const subs = getSubscriptionsList();
    expect(subs?.items.find((s) => s.id === "sub-1")?.unreadCount).toBe(5);
  });

  it("preserves the cached saved count when a web entry's counts omit saved", () => {
    handleSyncEvent(
      utils,
      queryClient,
      createNewEntryEvent({
        subscriptionId: "sub-1",
        feedType: "web",
        counts: {
          all: { unread: 19 },
          starred: { unread: 0 },
          subscriptions: [{ id: "sub-1", unread: 6 }],
          tags: [{ id: "tag-1", unread: 16 }],
          // saved omitted (web entries don't compute it)
        },
      })
    );

    // saved must not be clobbered to 0
    expect(getEntriesCount({ type: "saved" })?.unread).toBe(1);
  });

  it("is idempotent: applying the same new_entry twice does not double-count", () => {
    // Regression for the live-SSE / reconnect-catch-up overlap: the same
    // new_entry can be delivered by both paths. Because counts are absolute,
    // applying twice leaves the cache identical to applying once.
    const event = createNewEntryEvent({
      subscriptionId: "sub-1",
      feedType: "web",
      counts: {
        all: { unread: 19 },
        starred: { unread: 0 },
        subscriptions: [{ id: "sub-1", unread: 6 }],
        tags: [{ id: "tag-1", unread: 16 }],
      },
    });

    handleSyncEvent(utils, queryClient, event);
    handleSyncEvent(utils, queryClient, event);

    const subs = getSubscriptionsList();
    expect(subs?.items.find((s) => s.id === "sub-1")?.unreadCount).toBe(6); // not 7
    const tagsList = getTagsList();
    expect(tagsList?.items.find((t) => t.id === "tag-1")?.unreadCount).toBe(16); // not 17
    expect(getEntriesCount({})?.unread).toBe(19); // not 20
  });

  it("inserts the entry into cached lists when the event carries list data", () => {
    const before = getEntriesFromQueryClient().length;

    handleSyncEvent(
      utils,
      queryClient,
      createNewEntryEvent({
        entryId: "entry-live",
        subscriptionId: "sub-1",
        feedId: "feed-1",
        feedType: "web",
        updatedAt: "2024-07-01T00:00:00.000Z",
        entry: {
          url: "https://example.com/live",
          title: "Live Entry",
          author: "Live Author",
          summary: "Live summary",
          publishedAt: "2024-07-01T00:00:00.000Z",
          fetchedAt: "2024-07-01T00:00:00.000Z",
          siteName: null,
          feedTitle: "Feed One",
        },
      })
    );

    const inserted = findEntryInQueryClient("entry-live");
    expect(getEntriesFromQueryClient()).toHaveLength(before + 1);
    expect(inserted).toMatchObject({
      id: "entry-live",
      subscriptionId: "sub-1",
      feedId: "feed-1",
      type: "web",
      title: "Live Entry",
      feedTitle: "Feed One",
      read: false,
      starred: false,
    });
    // Date strings from the event become Date objects like a real list response
    expect(inserted?.publishedAt).toBeInstanceOf(Date);
    expect(inserted?.fetchedAt).toBeInstanceOf(Date);
    expect(inserted?.updatedAt).toBeInstanceOf(Date);
  });

  it("is idempotent: applying the same list-data event twice inserts one row", () => {
    const event = createNewEntryEvent({
      entryId: "entry-live",
      feedId: "feed-1",
      entry: {
        url: null,
        title: "Live Entry",
        author: null,
        summary: null,
        publishedAt: "2024-07-01T00:00:00.000Z",
        fetchedAt: "2024-07-01T00:00:00.000Z",
        siteName: null,
        feedTitle: "Feed One",
      },
    });

    handleSyncEvent(utils, queryClient, event);
    handleSyncEvent(utils, queryClient, event);

    const copies = getEntriesFromQueryClient().filter((e) => e.id === "entry-live");
    expect(copies).toHaveLength(1);
  });

  it("leaves lists unchanged when the event has no list data (older server)", () => {
    const before = getEntriesFromQueryClient().length;

    handleSyncEvent(
      utils,
      queryClient,
      createNewEntryEvent({ entryId: "entry-live", subscriptionId: "sub-1" })
    );

    expect(getEntriesFromQueryClient()).toHaveLength(before);
    expect(findEntryInQueryClient("entry-live")).toBeUndefined();
  });
});

// ============================================================================
// entry_updated Events
// ============================================================================

describe("handleSyncEvent - entry_updated", () => {
  it("updates metadata in entries.get cache", () => {
    handleSyncEvent(
      utils,
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
      utils,
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
      utils,
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
        utils,
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
  it("restores an entry that became unread into unreadOnly caches missing it", () => {
    // entry-3 is read in the seeded "All" cache. An unreadOnly cache fetched
    // while it was read doesn't contain it; marking it unread (e.g. on
    // another device) must insert it there, not just patch by ID.
    queryClient.setQueryData(
      [["entries", "list"], { input: { unreadOnly: true, limit: 25 }, type: "infinite" }],
      {
        pages: [
          {
            items: [DEFAULT_ENTRIES.find((e) => e.id === "entry-1")],
            nextCursor: undefined,
          },
        ],
        pageParams: [undefined],
      }
    );

    handleSyncEvent(
      utils,
      queryClient,
      createEntryStateChangedEvent({
        entryId: "entry-3",
        read: false,
        starred: false,
      })
    );

    const unreadList = queryClient.getQueryData<{
      pages: Array<{ items: Array<{ id: string; read: boolean }> }>;
    }>([["entries", "list"], { input: { unreadOnly: true, limit: 25 }, type: "infinite" }]);
    const ids = unreadList?.pages.flatMap((p) => p.items.map((i) => i.id));
    // Inserted in sorted position (entry-3 published 06-03 > entry-1 06-01)
    expect(ids).toEqual(["entry-3", "entry-1"]);
    // And the "All" cache still has exactly one copy, now unread
    const copies = getEntriesFromQueryClient().filter((e) => e.id === "entry-3");
    expect(copies.every((e) => e.read === false)).toBe(true);
  });

  it("updates read status in entries.list", () => {
    handleSyncEvent(
      utils,
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
      utils,
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
      utils,
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

  it("decrements unread counts when entry marked read (with server counts)", () => {
    // entry-1 is unread, starred, in sub-1 (tag-1), type=web
    handleSyncEvent(
      utils,
      queryClient,
      createEntryStateChangedEvent({
        entryId: "entry-1",
        read: true,
        starred: true,
        counts: {
          all: { unread: 17 },
          starred: { unread: 1 },
          saved: { unread: 1 },
          subscriptions: [{ id: "sub-1", unread: 4 }],
          tags: [{ id: "tag-1", unread: 14 }],
        },
      })
    );

    // Subscription unread count should decrease
    const subs = getSubscriptionsList();
    expect(subs?.items.find((s) => s.id === "sub-1")?.unreadCount).toBe(4); // was 5

    // Tag unread count should decrease
    const tagsList = getTagsList();
    expect(tagsList?.items.find((t) => t.id === "tag-1")?.unreadCount).toBe(14); // was 15

    // All Articles unread count should decrease
    expect(getEntriesCount({})?.unread).toBe(17); // was 18

    // Starred unread count should decrease (entry-1 is starred)
    expect(getEntriesCount({ starredOnly: true })?.unread).toBe(1); // was 2
  });

  it("increments unread counts when entry marked unread (with server counts)", () => {
    // entry-3 is read, not starred, in sub-2 (uncategorized), type=web
    handleSyncEvent(
      utils,
      queryClient,
      createEntryStateChangedEvent({
        entryId: "entry-3",
        read: false,
        starred: false,
        counts: {
          all: { unread: 19 },
          starred: { unread: 2 },
          saved: { unread: 1 },
          subscriptions: [{ id: "sub-2", unread: 4 }],
          tags: [],
          uncategorized: { unread: 4 },
        },
      })
    );

    // Subscription unread count should increase
    const subs = getSubscriptionsList();
    expect(subs?.items.find((s) => s.id === "sub-2")?.unreadCount).toBe(4); // was 3

    // Uncategorized unread count should increase
    const tagsList = getTagsList();
    expect(tagsList?.uncategorized.unreadCount).toBe(4); // was 3

    // All Articles unread count should increase
    expect(getEntriesCount({})?.unread).toBe(19); // was 18
  });

  it("updates starred unread count when starred state changes on unread entry", () => {
    // entry-2 is unread, not starred, in sub-1
    handleSyncEvent(
      utils,
      queryClient,
      createEntryStateChangedEvent({
        entryId: "entry-2",
        read: false,
        starred: true,
        counts: {
          all: { unread: 18 },
          starred: { unread: 3 },
          saved: { unread: 1 },
          subscriptions: [{ id: "sub-1", unread: 5 }],
          tags: [{ id: "tag-1", unread: 15 }],
        },
      })
    );

    // Starred unread should increase (entry became starred while unread)
    expect(getEntriesCount({ starredOnly: true })?.unread).toBe(3); // was 2
  });

  it("does not change counts when server-provided counts match cache (idempotent)", () => {
    // entry-1 is already unread+starred in cache — server provides same counts
    handleSyncEvent(
      utils,
      queryClient,
      createEntryStateChangedEvent({
        entryId: "entry-1",
        read: false,
        starred: true,
        counts: {
          all: { unread: 18 },
          starred: { unread: 2 },
          subscriptions: [{ id: "sub-1", unread: 5 }],
          tags: [{ id: "tag-1", unread: 15 }],
        },
      })
    );

    const subs = getSubscriptionsList();
    expect(subs?.items.find((s) => s.id === "sub-1")?.unreadCount).toBe(5); // unchanged
    expect(getEntriesCount({})?.unread).toBe(18); // unchanged
    expect(getEntriesCount({ starredOnly: true })?.unread).toBe(2); // unchanged
  });

  it("sets counts from server even for non-cached entries", () => {
    handleSyncEvent(
      utils,
      queryClient,
      createEntryStateChangedEvent({
        entryId: "non-existent-entry",
        read: true,
        starred: false,
        counts: {
          all: { unread: 17 },
          starred: { unread: 2 },
          subscriptions: [{ id: "sub-1", unread: 4 }],
          tags: [{ id: "tag-1", unread: 14 }],
        },
      })
    );

    // Counts are set from the server-provided values
    expect(getEntriesCount({})?.unread).toBe(17);
    expect(getSubscriptionsList()?.items.find((s) => s.id === "sub-1")?.unreadCount).toBe(4);
  });
});

// ============================================================================
// mark_all_read Events
// ============================================================================

describe("handleSyncEvent - mark_all_read", () => {
  it("invalidates entry lists and counts (mirrors the acting tab)", () => {
    handleSyncEvent(utils, queryClient, createMarkAllReadEvent());

    const invalidated = invalidatedProcedures(invalidateSpy);
    // The one SSE event that deliberately refetches entries.list.
    expect(invalidated).toContain("entries.list");
    expect(invalidated).toContain("entries.count");
    expect(invalidated).toContain("tags.list");
    expect(invalidated).toContain("subscriptions.list");
  });

  it("does not touch entry read state directly (invalidation handles it)", () => {
    // entry-1/entry-2 stay as-is in the cache; the refetch (not a direct patch)
    // is what will mark them read, so the handler itself changes nothing.
    handleSyncEvent(utils, queryClient, createMarkAllReadEvent());

    expect(findEntryInQueryClient("entry-1")?.read).toBe(false);
    expect(findEntryInQueryClient("entry-2")?.read).toBe(false);
  });
});

// ============================================================================
// subscription_created Events
// ============================================================================

describe("handleSyncEvent - subscription_created", () => {
  it("adds the subscription and sets absolute counts from the event", () => {
    // A subscription_created with a tag exercises the handler's tag-count
    // setting (the server only sends untagged created events, but the handler
    // applies whatever absolute counts it's given).
    handleSyncEvent(
      utils,
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
        counts: {
          all: { unread: 25 },
          starred: { unread: 1 },
          subscriptions: [{ id: "sub-new", unread: 7 }],
          tags: [{ id: "tag-1", unread: 22 }],
        },
      })
    );

    const subs = getSubscriptionsList();
    const newSub = subs?.items.find((s) => s.id === "sub-new");
    expect(newSub).toBeDefined();
    expect(newSub?.unreadCount).toBe(7);

    const tagsList = getTagsList();
    expect(tagsList?.items.find((t) => t.id === "tag-1")?.unreadCount).toBe(22); // set

    expect(getEntriesCount({})?.unread).toBe(25); // set
  });

  it("sets uncategorized count from the event for an untagged subscription", () => {
    handleSyncEvent(
      utils,
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
        counts: {
          all: { unread: 21 },
          starred: { unread: 1 },
          subscriptions: [{ id: "sub-new", unread: 3 }],
          tags: [],
          uncategorized: { unread: 6 },
        },
      })
    );

    const tagsList = getTagsList();
    expect(tagsList?.uncategorized.unreadCount).toBe(6); // set

    expect(getEntriesCount({})?.unread).toBe(21); // set
  });

  it("is idempotent: applying the same created event twice does not inflate", () => {
    const event = createSubscriptionCreatedEvent({
      counts: {
        all: { unread: 25 },
        starred: { unread: 1 },
        subscriptions: [{ id: "sub-new", unread: 7 }],
        tags: [{ id: "tag-1", unread: 22 }],
      },
    });

    handleSyncEvent(utils, queryClient, event);
    handleSyncEvent(utils, queryClient, event);

    expect(getEntriesCount({})?.unread).toBe(25); // not doubled
    expect(getTagsList()?.items.find((t) => t.id === "tag-1")?.unreadCount).toBe(22);
  });

  it("uses customTitle when provided", () => {
    handleSyncEvent(
      utils,
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
      utils,
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
      utils,
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
    setUtilsData(
      utils.subscriptions.get,
      { id: "sub-1" },
      {
        ...DEFAULT_SUBSCRIPTIONS[0],
        originalTitle: "Feed One Original",
      }
    );

    handleSyncEvent(
      utils,
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
    invalidateSpy.mockClear();
    handleSyncEvent(utils, queryClient, createSubscriptionUpdatedEvent());

    const paths = invalidatedProcedures(invalidateSpy);
    expect(paths).toContain("tags.list");
    expect(paths).toContain("subscriptions.list");
  });
});

// ============================================================================
// subscription_deleted Events
// ============================================================================

describe("handleSyncEvent - subscription_deleted", () => {
  it("removes the subscription and sets absolute counts from the event", () => {
    handleSyncEvent(
      utils,
      queryClient,
      createSubscriptionDeletedEvent({
        subscriptionId: "sub-1",
        counts: {
          all: { unread: 13 },
          starred: { unread: 1 },
          subscriptions: [],
          tags: [{ id: "tag-1", unread: 10 }],
        },
      })
    );

    const subs = getSubscriptionsList();
    expect(subs?.items.find((s) => s.id === "sub-1")).toBeUndefined();

    const tagsList = getTagsList();
    expect(tagsList?.items.find((t) => t.id === "tag-1")?.unreadCount).toBe(10); // set

    expect(getEntriesCount({})?.unread).toBe(13); // set
  });

  it("removes an uncategorized subscription and sets uncategorized count", () => {
    handleSyncEvent(
      utils,
      queryClient,
      createSubscriptionDeletedEvent({
        subscriptionId: "sub-2", // sub-2 has no tags
        counts: {
          all: { unread: 15 },
          starred: { unread: 1 },
          subscriptions: [],
          tags: [],
          uncategorized: { unread: 0 },
        },
      })
    );

    const subs = getSubscriptionsList();
    expect(subs?.items.find((s) => s.id === "sub-2")).toBeUndefined();

    const tagsList = getTagsList();
    expect(tagsList?.uncategorized.unreadCount).toBe(0); // set

    expect(getEntriesCount({})?.unread).toBe(15); // set
  });

  it("invalidates the count caches when the event omits counts (sync catch-up)", () => {
    invalidateSpy.mockClear();
    handleSyncEvent(
      utils,
      queryClient,
      createSubscriptionDeletedEvent({ subscriptionId: "sub-1" })
    );

    // Subscription removed structurally...
    expect(getSubscriptionsList()?.items.find((s) => s.id === "sub-1")).toBeUndefined();
    // ...and the count caches are invalidated rather than set (no counts to set).
    const paths = invalidatedProcedures(invalidateSpy);
    expect(paths).toContain("tags.list");
    expect(paths).toContain("entries.count");
  });

  it("is a no-op when subscription already removed (optimistic update)", () => {
    // First remove it
    handleSyncEvent(
      utils,
      queryClient,
      createSubscriptionDeletedEvent({
        subscriptionId: "sub-1",
      })
    );

    const countAfterFirst = getEntriesCount({})?.unread;

    // Second delete should be a no-op (alreadyRemoved check)
    handleSyncEvent(
      utils,
      queryClient,
      createSubscriptionDeletedEvent({
        subscriptionId: "sub-1",
      })
    );

    expect(getEntriesCount({})?.unread).toBe(countAfterFirst);
  });

  it("processes delete for subscription only in infinite queries (not in lookup map)", () => {
    // Simulate a pre-existing subscription that was loaded by the sidebar's
    // infinite query but never seen via an SSE subscription_created event,
    // so it's only in the QueryClient's infinite query cache, not the lookup map.
    const preExistingSub = {
      id: "sub-preexisting",
      type: "web",
      url: "https://example.com/preexisting.xml",
      title: "Pre-existing Feed",
      originalTitle: "Pre-existing Feed",
      description: null,
      siteUrl: null,
      subscribedAt: new Date("2024-01-01"),
      unreadCount: 4,
      tags: [{ id: "tag-1", name: "Tech", color: "#ff0000" }],
      fetchFullContent: false,
    };

    // Seed ONLY into the QueryClient's infinite query (not the lookup map)
    queryClient.setQueryData(
      [["subscriptions", "list"], { input: { tagId: "tag-1" }, type: "infinite" }],
      {
        pages: [{ items: [preExistingSub], nextCursor: undefined }],
        pageParams: [undefined],
      }
    );

    // Seed tags/counts so we can verify targeted cleanup
    setUtilsData(utils.tags.list, undefined, {
      items: [
        { id: "tag-1", name: "Tech", color: "#ff0000", feedCount: 3, unreadCount: 19 },
        { id: "tag-2", name: "Science", color: "#00ff00", feedCount: 1, unreadCount: 10 },
      ],
      uncategorized: { feedCount: 1, unreadCount: 3 },
    });
    setUtilsData(utils.entries.count, {}, { unread: 22 });

    invalidateSpy.mockClear();
    handleSyncEvent(
      utils,
      queryClient,
      createSubscriptionDeletedEvent({
        subscriptionId: "sub-preexisting",
      })
    );

    // Should NOT be treated as "already removed" — it should be processed.
    const paths = invalidatedProcedures(invalidateSpy);
    expect(paths).toContain("entries.list");
    // No counts on the event (sync path) → the count caches are invalidated.
    expect(paths).toContain("tags.list");
    expect(paths).toContain("entries.count");

    // The subscription is removed from the infinite-query cache.
    const remaining = queryClient.getQueryData<{
      pages: Array<{ items: Array<{ id: string }> }>;
    }>([["subscriptions", "list"], { input: { tagId: "tag-1" }, type: "infinite" }]);
    expect(remaining?.pages[0]?.items.some((s) => s.id === "sub-preexisting")).toBe(false);
  });

  it("is a no-op when subscription not in any cache (treated as already removed)", () => {
    // When the subscription is not in the lookup map or any infinite query,
    // the handler treats it as "already removed" and skips processing.
    invalidateSpy.mockClear();
    handleSyncEvent(
      utils,
      queryClient,
      createSubscriptionDeletedEvent({
        subscriptionId: "sub-unknown",
      })
    );

    // No invalidations should occur (the alreadyRemoved check returns true)
    expect(invalidateSpy).not.toHaveBeenCalled();
  });
});

// ============================================================================
// tag_created Events
// ============================================================================

describe("handleSyncEvent - tag_created", () => {
  it("adds new tag with zero counts", () => {
    handleSyncEvent(
      utils,
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

    handleSyncEvent(utils, queryClient, event);

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
      utils,
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
      utils,
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
    invalidateSpy.mockClear();
    handleSyncEvent(
      utils,
      queryClient,
      createImportProgressEvent({
        importId: "import-1",
      })
    );

    const invalidations = invalidatedQueries(invalidateSpy);
    expect(
      invalidations.some(
        (q) => q.path === "imports.get" && (q.input as { id?: string })?.id === "import-1"
      )
    ).toBe(true);
    expect(invalidations.some((q) => q.path === "imports.list")).toBe(true);
  });
});

// ============================================================================
// import_completed Events
// ============================================================================

describe("handleSyncEvent - import_completed", () => {
  it("invalidates imports.get and imports.list", () => {
    invalidateSpy.mockClear();
    handleSyncEvent(utils, queryClient, {
      type: "import_completed",
      importId: "import-2",
      imported: 10,
      skipped: 2,
      failed: 1,
      total: 13,
      timestamp: "2024-07-01T00:00:00.000Z",
      updatedAt: "2024-07-01T00:00:00.000Z",
    });

    const invalidations = invalidatedQueries(invalidateSpy);
    expect(
      invalidations.some(
        (q) => q.path === "imports.get" && (q.input as { id?: string })?.id === "import-2"
      )
    ).toBe(true);
    expect(invalidations.some((q) => q.path === "imports.list")).toBe(true);
  });
});

// ============================================================================
// Cross-Tab Synchronization (entry_state_changed + unread counts)
//
// These tests simulate the cross-tab scenario described in #796:
//   Tab A: marks entry read → mutation updates local cache + server
//   Server: broadcasts entry_state_changed via SSE to all tabs
//   Tab B: receives event → handleSyncEvent should update BOTH
//          entry state AND unread counts
//
// The seeded cache state represents Tab B's view. The event represents
// the SSE message Tab B receives after Tab A's action.
// ============================================================================

describe("handleSyncEvent - cross-tab unread count sync (#796)", () => {
  it("Tab B decrements all unread counts when Tab A marks a tagged entry read", () => {
    // Tab B's cache: entry-1 is unread, starred, in sub-1 (tag-1)
    // Tab A marks entry-1 read → SSE delivers entry_state_changed with absolute counts
    handleSyncEvent(
      utils,
      queryClient,
      createEntryStateChangedEvent({
        entryId: "entry-1",
        read: true,
        starred: true, // starred state unchanged
        counts: {
          all: { unread: 17 },
          starred: { unread: 1 },
          saved: { unread: 1 },
          subscriptions: [{ id: "sub-1", unread: 4 }],
          tags: [{ id: "tag-1", unread: 14 }],
        },
      })
    );

    // Subscription count: sub-1 was 5 unread → 4
    const subs = getSubscriptionsList();
    expect(subs?.items.find((s) => s.id === "sub-1")?.unreadCount).toBe(4);

    // Tag count: tag-1 was 15 unread → 14
    const tagsList = getTagsList();
    expect(tagsList?.items.find((t) => t.id === "tag-1")?.unreadCount).toBe(14);

    // All Articles: was 18 → 17
    expect(getEntriesCount({})?.unread).toBe(17);

    // Starred unread: entry-1 is starred, so starred count drops: was 2 → 1
    expect(getEntriesCount({ starredOnly: true })?.unread).toBe(1);

    // Saved unread: unaffected (entry-1 is type=web, not saved)
    expect(getEntriesCount({ type: "saved" })?.unread).toBe(1);
  });

  it("Tab B decrements uncategorized count when Tab A marks an untagged entry read", () => {
    // Tab A marks an uncategorized entry read → SSE delivers absolute counts
    handleSyncEvent(
      utils,
      queryClient,
      createEntryStateChangedEvent({
        entryId: "entry-uncat-unread",
        read: true,
        starred: false,
        counts: {
          all: { unread: 17 },
          starred: { unread: 2 },
          saved: { unread: 1 },
          subscriptions: [{ id: "sub-2", unread: 2 }],
          tags: [],
          uncategorized: { unread: 2 },
        },
      })
    );

    // Sub-2 unread: was 3 → 2
    const subs = getSubscriptionsList();
    expect(subs?.items.find((s) => s.id === "sub-2")?.unreadCount).toBe(2);

    // Uncategorized: was 3 → 2
    const tagsList = getTagsList();
    expect(tagsList?.uncategorized.unreadCount).toBe(2);

    // All Articles: was 18 → 17
    expect(getEntriesCount({})?.unread).toBe(17);
  });

  it("Tab B increments counts when Tab A marks an entry unread", () => {
    // entry-3 is read, not starred, in sub-2 (uncategorized)
    handleSyncEvent(
      utils,
      queryClient,
      createEntryStateChangedEvent({
        entryId: "entry-3",
        read: false,
        starred: false,
        counts: {
          all: { unread: 19 },
          starred: { unread: 2 },
          saved: { unread: 1 },
          subscriptions: [{ id: "sub-2", unread: 4 }],
          tags: [],
          uncategorized: { unread: 4 },
        },
      })
    );

    // Sub-2: was 3 → 4
    const subs = getSubscriptionsList();
    expect(subs?.items.find((s) => s.id === "sub-2")?.unreadCount).toBe(4);

    // Uncategorized: was 3 → 4
    const tagsList = getTagsList();
    expect(tagsList?.uncategorized.unreadCount).toBe(4);

    // All Articles: was 18 → 19
    expect(getEntriesCount({})?.unread).toBe(19);
  });

  it("Tab B updates starred count when Tab A stars an unread entry", () => {
    // entry-2 is unread, not starred, in sub-1
    handleSyncEvent(
      utils,
      queryClient,
      createEntryStateChangedEvent({
        entryId: "entry-2",
        read: false,
        starred: true,
        counts: {
          all: { unread: 18 },
          starred: { unread: 3 },
          saved: { unread: 1 },
          subscriptions: [{ id: "sub-1", unread: 5 }],
          tags: [{ id: "tag-1", unread: 15 }],
        },
      })
    );

    // Starred unread: was 2 → 3 (entry-2 became starred while unread)
    expect(getEntriesCount({ starredOnly: true })?.unread).toBe(3);

    // Subscription/tag/all counts unchanged (read state didn't change)
    expect(getSubscriptionsList()?.items.find((s) => s.id === "sub-1")?.unreadCount).toBe(5);
    expect(getEntriesCount({})?.unread).toBe(18);
  });

  it("starring a non-saved entry does not clobber saved count", () => {
    // Star event for a web entry — server doesn't compute saved count,
    // so the event omits it. Saved count should be preserved.
    handleSyncEvent(
      utils,
      queryClient,
      createEntryStateChangedEvent({
        entryId: "entry-2",
        read: false,
        starred: true,
        counts: {
          all: { unread: 18 },
          starred: { unread: 3 },
          // saved intentionally omitted — server doesn't compute it for non-saved entries
          subscriptions: [{ id: "sub-1", unread: 5 }],
          tags: [{ id: "tag-1", unread: 15 }],
        },
      })
    );

    // Saved count should be unchanged (was 1)
    expect(getEntriesCount({ type: "saved" })?.unread).toBe(1);
    // Starred should update
    expect(getEntriesCount({ starredOnly: true })?.unread).toBe(3);
  });

  it("Tab B updates starred count when Tab A unstars an unread entry", () => {
    // entry-1 is unread, starred, in sub-1
    handleSyncEvent(
      utils,
      queryClient,
      createEntryStateChangedEvent({
        entryId: "entry-1",
        read: false,
        starred: false,
        counts: {
          all: { unread: 18 },
          starred: { unread: 1 },
          saved: { unread: 1 },
          subscriptions: [{ id: "sub-1", unread: 5 }],
          tags: [{ id: "tag-1", unread: 15 }],
        },
      })
    );

    // Starred unread: was 2 → 1 (entry-1 lost its star while unread)
    expect(getEntriesCount({ starredOnly: true })?.unread).toBe(1);

    // Subscription/tag/all counts unchanged (read state didn't change)
    expect(getSubscriptionsList()?.items.find((s) => s.id === "sub-1")?.unreadCount).toBe(5);
    expect(getEntriesCount({})?.unread).toBe(18);
  });

  it("Tab A's optimistic update is corrected by server-provided counts from SSE event", () => {
    // Simulate Tab A: entry-1 was already optimistically marked read in THIS tab.
    // Update BOTH entries.list and entries.get (as the real optimistic update does).
    queryClient.setQueriesData<{
      pages: Array<{ items: Array<Record<string, unknown>> }>;
      pageParams: unknown[];
    }>({ queryKey: [["entries", "list"]] }, (oldData) => {
      if (!oldData?.pages) return oldData;
      return {
        ...oldData,
        pages: oldData.pages.map((page) => ({
          ...page,
          items: page.items.map((entry) =>
            entry.id === "entry-1" ? { ...entry, read: true } : entry
          ),
        })),
      };
    });
    setUtilsData(
      utils.entries.get,
      { id: "entry-1" },
      {
        entry: { ...DEFAULT_ENTRIES[0], read: true },
      }
    );

    // Now the SSE event arrives with read=true and absolute counts from server
    handleSyncEvent(
      utils,
      queryClient,
      createEntryStateChangedEvent({
        entryId: "entry-1",
        read: true,
        starred: true,
        counts: {
          all: { unread: 17 },
          starred: { unread: 1 },
          subscriptions: [{ id: "sub-1", unread: 4 }],
          tags: [{ id: "tag-1", unread: 14 }],
        },
      })
    );

    // Counts are set to server-provided values (correcting any optimistic drift)
    expect(getSubscriptionsList()?.items.find((s) => s.id === "sub-1")?.unreadCount).toBe(4);
    expect(getEntriesCount({})?.unread).toBe(17);
    expect(getEntriesCount({ starredOnly: true })?.unread).toBe(1);
  });

  it("handles simultaneous read + star change in one event", () => {
    // entry-2: unread, not starred, in sub-1 (tag-1)
    // Tab A marks it read AND stars it at the same time
    handleSyncEvent(
      utils,
      queryClient,
      createEntryStateChangedEvent({
        entryId: "entry-2",
        read: true,
        starred: true,
        counts: {
          all: { unread: 17 },
          starred: { unread: 2 },
          saved: { unread: 1 },
          subscriptions: [{ id: "sub-1", unread: 4 }],
          tags: [{ id: "tag-1", unread: 14 }],
        },
      })
    );

    // Read changed: unread counts decrement
    expect(getSubscriptionsList()?.items.find((s) => s.id === "sub-1")?.unreadCount).toBe(4); // -1
    expect(getEntriesCount({})?.unread).toBe(17); // -1
    expect(getTagsList()?.items.find((t) => t.id === "tag-1")?.unreadCount).toBe(14); // -1

    // Starred changed on now-read entry: starred unread count unaffected
    // (entry is read, so starring it doesn't add to starred *unread* count)
    expect(getEntriesCount({ starredOnly: true })?.unread).toBe(2); // unchanged
  });

  it("updates counts for uncached entry when counts are provided", () => {
    // SSE event for an entry in neither entries.list NOR entries.get,
    // but the server provides absolute counts.
    handleSyncEvent(
      utils,
      queryClient,
      createEntryStateChangedEvent({
        entryId: "entry-completely-unknown",
        read: true,
        starred: false,
        counts: {
          all: { unread: 17 },
          starred: { unread: 2 },
          saved: { unread: 1 },
          subscriptions: [{ id: "sub-1", unread: 4 }],
          tags: [{ id: "tag-1", unread: 14 }],
        },
      })
    );

    // Counts should update from server-provided absolute values
    expect(getSubscriptionsList()?.items.find((s) => s.id === "sub-1")?.unreadCount).toBe(4); // -1
    expect(getSubscriptionsList()?.items.find((s) => s.id === "sub-2")?.unreadCount).toBe(3); // unchanged
    expect(getEntriesCount({})?.unread).toBe(17); // -1
    expect(getEntriesCount({ starredOnly: true })?.unread).toBe(2); // unchanged (not starred)
    expect(getEntriesCount({ type: "saved" })?.unread).toBe(1); // unchanged (type=web)
  });

  // --------------------------------------------------------------------------
  // Saved articles (type="saved", subscriptionId=null)
  // --------------------------------------------------------------------------

  it("decrements saved unread count when Tab A marks a saved article read", () => {
    // entry-saved: type=saved, subscriptionId=null, unread, not starred
    handleSyncEvent(
      utils,
      queryClient,
      createEntryStateChangedEvent({
        entryId: "entry-saved",
        read: true,
        starred: false,
        counts: {
          all: { unread: 17 },
          starred: { unread: 2 },
          saved: { unread: 0 },
          subscriptions: [],
          tags: [],
        },
      })
    );

    // Saved unread: was 1 → 0
    expect(getEntriesCount({ type: "saved" })?.unread).toBe(0);

    // All Articles: was 18 → 17
    expect(getEntriesCount({})?.unread).toBe(17);

    // Subscription counts unchanged (saved articles have no subscription)
    expect(getSubscriptionsList()?.items.find((s) => s.id === "sub-1")?.unreadCount).toBe(5);
    expect(getSubscriptionsList()?.items.find((s) => s.id === "sub-2")?.unreadCount).toBe(3);

    // Tag counts unchanged
    const tagsList = getTagsList();
    expect(tagsList?.items.find((t) => t.id === "tag-1")?.unreadCount).toBe(15);
    expect(tagsList?.uncategorized.unreadCount).toBe(3);
  });

  it("increments saved unread count when Tab A marks a saved article unread", () => {
    // First mark it read
    handleSyncEvent(
      utils,
      queryClient,
      createEntryStateChangedEvent({
        entryId: "entry-saved",
        read: true,
        starred: false,
        counts: {
          all: { unread: 17 },
          starred: { unread: 2 },
          saved: { unread: 0 },
          subscriptions: [],
          tags: [],
        },
      })
    );
    expect(getEntriesCount({ type: "saved" })?.unread).toBe(0);

    // Now mark it unread again
    handleSyncEvent(
      utils,
      queryClient,
      createEntryStateChangedEvent({
        entryId: "entry-saved",
        read: false,
        starred: false,
        counts: {
          all: { unread: 18 },
          starred: { unread: 2 },
          saved: { unread: 1 },
          subscriptions: [],
          tags: [],
        },
      })
    );

    // Saved unread: back to 1
    expect(getEntriesCount({ type: "saved" })?.unread).toBe(1);
    expect(getEntriesCount({})?.unread).toBe(18);
  });

  // --------------------------------------------------------------------------
  // Orphaned starred entries (subscriptionId=null, starred)
  // --------------------------------------------------------------------------

  it("decrements starred count when Tab A marks an orphaned starred entry read", () => {
    // entry-starred-orphan: type=web, subscriptionId=null, unread, starred
    handleSyncEvent(
      utils,
      queryClient,
      createEntryStateChangedEvent({
        entryId: "entry-starred-orphan",
        read: true,
        starred: true,
        counts: {
          all: { unread: 17 },
          starred: { unread: 1 },
          saved: { unread: 1 },
          subscriptions: [],
          tags: [],
        },
      })
    );

    // Starred unread: was 2 → 1
    expect(getEntriesCount({ starredOnly: true })?.unread).toBe(1);

    // All Articles: was 18 → 17
    expect(getEntriesCount({})?.unread).toBe(17);

    // Subscription counts unchanged (orphaned entry has no subscription)
    expect(getSubscriptionsList()?.items.find((s) => s.id === "sub-1")?.unreadCount).toBe(5);
  });

  it("decrements both starred and All count when orphaned starred entry marked read", () => {
    // Verify the starred orphan entry affects starred unread but no subscription/tag counts
    handleSyncEvent(
      utils,
      queryClient,
      createEntryStateChangedEvent({
        entryId: "entry-starred-orphan",
        read: true,
        starred: true,
        counts: {
          all: { unread: 17 },
          starred: { unread: 1 },
          saved: { unread: 1 },
          subscriptions: [],
          tags: [],
        },
      })
    );

    const tagsList = getTagsList();
    expect(tagsList?.items.find((t) => t.id === "tag-1")?.unreadCount).toBe(15); // unchanged
    expect(tagsList?.items.find((t) => t.id === "tag-2")?.unreadCount).toBe(10); // unchanged
    expect(tagsList?.uncategorized.unreadCount).toBe(3); // unchanged
    expect(getEntriesCount({ type: "saved" })?.unread).toBe(1); // unchanged
  });

  // --------------------------------------------------------------------------
  // entries.get fallback (entry not in list cache, only in single-entry cache)
  // --------------------------------------------------------------------------

  it("updates counts via server counts when entry is not in entries.list", () => {
    // Remove all entries from the list cache (simulating Tab B hasn't loaded
    // any list, but has opened entry-saved individually)
    queryClient.setQueryData([["entries", "list"], { input: { limit: 25 }, type: "infinite" }], {
      pages: [{ items: [], nextCursor: undefined }],
      pageParams: [undefined],
    });

    // entry-saved: type=saved, subscriptionId=null, unread, not starred
    // Server provides absolute counts
    handleSyncEvent(
      utils,
      queryClient,
      createEntryStateChangedEvent({
        entryId: "entry-saved",
        read: true,
        starred: false,
        counts: {
          all: { unread: 17 },
          starred: { unread: 2 },
          saved: { unread: 0 },
          subscriptions: [],
          tags: [],
        },
      })
    );

    // Saved unread should update via server counts
    expect(getEntriesCount({ type: "saved" })?.unread).toBe(0); // was 1
    expect(getEntriesCount({})?.unread).toBe(17); // was 18
  });

  it("updates starred count via server counts for orphan not in list cache", () => {
    // Clear list cache
    queryClient.setQueryData([["entries", "list"], { input: { limit: 25 }, type: "infinite" }], {
      pages: [{ items: [], nextCursor: undefined }],
      pageParams: [undefined],
    });

    // entry-starred-orphan: type=web, subscriptionId=null, unread, starred
    handleSyncEvent(
      utils,
      queryClient,
      createEntryStateChangedEvent({
        entryId: "entry-starred-orphan",
        read: true,
        starred: true,
        counts: {
          all: { unread: 17 },
          starred: { unread: 1 },
          saved: { unread: 1 },
          subscriptions: [],
          tags: [],
        },
      })
    );

    // Starred unread should update via server counts
    expect(getEntriesCount({ starredOnly: true })?.unread).toBe(1); // was 2
    expect(getEntriesCount({})?.unread).toBe(17); // was 18
  });

  it("updates subscription count via server counts for entry not in list cache", () => {
    // Clear list cache
    queryClient.setQueryData([["entries", "list"], { input: { limit: 25 }, type: "infinite" }], {
      pages: [{ items: [], nextCursor: undefined }],
      pageParams: [undefined],
    });

    // entry-1: sub-1, web, unread, starred — only in entries.get
    handleSyncEvent(
      utils,
      queryClient,
      createEntryStateChangedEvent({
        entryId: "entry-1",
        read: true,
        starred: true,
        counts: {
          all: { unread: 17 },
          starred: { unread: 1 },
          saved: { unread: 1 },
          subscriptions: [{ id: "sub-1", unread: 4 }],
          tags: [{ id: "tag-1", unread: 14 }],
        },
      })
    );

    // Subscription count should update
    expect(getSubscriptionsList()?.items.find((s) => s.id === "sub-1")?.unreadCount).toBe(4); // was 5
    expect(getEntriesCount({})?.unread).toBe(17); // was 18
    expect(getEntriesCount({ starredOnly: true })?.unread).toBe(1); // was 2
    expect(getTagsList()?.items.find((t) => t.id === "tag-1")?.unreadCount).toBe(14); // was 15
  });

  it("handles multi-tag subscription correctly with server counts", () => {
    // Tab A marks an entry in sub-3 (tag-1 and tag-2) as read
    handleSyncEvent(
      utils,
      queryClient,
      createEntryStateChangedEvent({
        entryId: "entry-multi-tag",
        read: true,
        starred: false,
        counts: {
          all: { unread: 17 },
          starred: { unread: 2 },
          saved: { unread: 1 },
          subscriptions: [{ id: "sub-3", unread: 9 }],
          tags: [
            { id: "tag-1", unread: 14 },
            { id: "tag-2", unread: 9 },
          ],
        },
      })
    );

    // sub-3 unread: was 10 → 9
    expect(getSubscriptionsList()?.items.find((s) => s.id === "sub-3")?.unreadCount).toBe(9);

    // Both tags should decrement
    const tagsList = getTagsList();
    expect(tagsList?.items.find((t) => t.id === "tag-1")?.unreadCount).toBe(14); // was 15
    expect(tagsList?.items.find((t) => t.id === "tag-2")?.unreadCount).toBe(9); // was 10

    // All Articles: was 18 → 17
    expect(getEntriesCount({})?.unread).toBe(17);
  });
});

// ============================================================================
// Event Sequences
// ============================================================================

describe("handleSyncEvent - event sequences", () => {
  it("new_entry then entry_state_changed(read): count decrements back", () => {
    // New entry arrives - sub-1 unread goes from 5 to 6 (absolute server counts)
    handleSyncEvent(
      utils,
      queryClient,
      createNewEntryEvent({
        subscriptionId: "sub-1",
        entryId: "new-entry-seq",
        feedType: "web",
        counts: {
          all: { unread: 19 },
          starred: { unread: 2 },
          subscriptions: [{ id: "sub-1", unread: 6 }],
          tags: [{ id: "tag-1", unread: 16 }],
        },
      })
    );

    const subsAfterNew = getSubscriptionsList();
    expect(subsAfterNew?.items.find((s) => s.id === "sub-1")?.unreadCount).toBe(6);
    expect(getEntriesCount({})?.unread).toBe(19);

    // Then the entry is marked read via state_changed from another tab.
    // Server provides absolute counts that reflect the mark-read.
    handleSyncEvent(
      utils,
      queryClient,
      createEntryStateChangedEvent({
        entryId: "new-entry-seq",
        read: true,
        starred: false,
        counts: {
          all: { unread: 18 },
          starred: { unread: 2 },
          saved: { unread: 1 },
          subscriptions: [{ id: "sub-1", unread: 5 }],
          tags: [{ id: "tag-1", unread: 15 }],
        },
      })
    );

    // Counts decrement back to original
    expect(getSubscriptionsList()?.items.find((s) => s.id === "sub-1")?.unreadCount).toBe(5);
    expect(getEntriesCount({})?.unread).toBe(18);
  });

  it("entry_state_changed(read) sets counts from server", () => {
    // entry-1 is unread+starred in sub-1 (tag-1) — server provides updated counts
    handleSyncEvent(
      utils,
      queryClient,
      createEntryStateChangedEvent({
        entryId: "entry-1",
        read: true,
        starred: true,
        counts: {
          all: { unread: 17 },
          starred: { unread: 1 },
          subscriptions: [{ id: "sub-1", unread: 4 }],
          tags: [{ id: "tag-1", unread: 14 }],
        },
      })
    );

    // Counts set to server-provided absolute values
    expect(getSubscriptionsList()?.items.find((s) => s.id === "sub-1")?.unreadCount).toBe(4);
    expect(getEntriesCount({})?.unread).toBe(17);
    expect(getEntriesCount({ starredOnly: true })?.unread).toBe(1);
  });

  it("subscription_created then new_entry for it: counts correct from both", () => {
    // Create a new subscription
    handleSyncEvent(
      utils,
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
        counts: {
          all: { unread: 20 },
          starred: { unread: 1 },
          subscriptions: [{ id: "sub-seq", unread: 2 }],
          tags: [{ id: "tag-2", unread: 12 }],
        },
      })
    );

    expect(getEntriesCount({})?.unread).toBe(20); // 18 + 2

    // Now a new entry arrives for that subscription. Its server-computed
    // absolute counts reflect the post-insert state.
    handleSyncEvent(
      utils,
      queryClient,
      createNewEntryEvent({
        subscriptionId: "sub-seq",
        feedType: "web",
        counts: {
          all: { unread: 21 },
          starred: { unread: 1 },
          subscriptions: [{ id: "sub-seq", unread: 3 }],
          tags: [{ id: "tag-2", unread: 13 }],
        },
      })
    );

    expect(getEntriesCount({})?.unread).toBe(21); // 20 + 1

    const subs = getSubscriptionsList();
    expect(subs?.items.find((s) => s.id === "sub-seq")?.unreadCount).toBe(3); // 2 + 1

    const tagsList = getTagsList();
    const tag2 = tagsList?.items.find((t) => t.id === "tag-2");
    expect(tag2?.unreadCount).toBe(13); // 10 + 2 (sub) + 1 (entry)
  });

  it("subscription_created then subscription_deleted: clean slate", () => {
    handleSyncEvent(
      utils,
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
        counts: {
          all: { unread: 23 },
          starred: { unread: 1 },
          subscriptions: [{ id: "sub-temp", unread: 5 }],
          tags: [],
          uncategorized: { unread: 8 },
        },
      })
    );

    expect(getEntriesCount({})?.unread).toBe(23); // 18 + 5

    handleSyncEvent(
      utils,
      queryClient,
      createSubscriptionDeletedEvent({
        subscriptionId: "sub-temp",
        counts: {
          all: { unread: 18 },
          starred: { unread: 1 },
          subscriptions: [],
          tags: [],
          uncategorized: { unread: 3 },
        },
      })
    );

    const subs = getSubscriptionsList();
    expect(subs?.items.find((s) => s.id === "sub-temp")).toBeUndefined();
    expect(getEntriesCount({})?.unread).toBe(18); // back to original
  });
});

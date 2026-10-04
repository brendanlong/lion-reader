/**
 * Integration tests for handleSyncEvent.
 *
 * Tests the full event → cache-state pipeline by calling handleSyncEvent()
 * with realistic pre-seeded cache state and asserting the resulting cache values.
 *
 * Uses a real QueryClient and real tRPC query utils (createRealTrpcUtils) so the
 * cache helpers run against genuine React Query key hashing, not a fake.
 */

import { describe, it, expect, beforeEach, vi, type MockInstance } from "vitest";
import { handleSyncEvent } from "@/lib/cache/event-handlers";
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
import { getLocalDb } from "@/lib/local-db/local-db";
import { entryListKey } from "@/lib/local-db/entry-lists";
import type { EntryRow } from "@/lib/local-db/entries";

// ============================================================================
// Test Setup
// ============================================================================

let utils: TRPCClientUtils;
let queryClient: QueryClient;
let invalidateSpy: MockInstance;

beforeEach(() => {
  queryClient = createSeededQueryClient();
  utils = createRealTrpcUtils(queryClient);
  seedCacheState(utils, queryClient);
  // Spy after seeding so only the event-driven invalidations are recorded.
  invalidateSpy = spyOnInvalidate(queryClient);
});

// ============================================================================
// Helper Functions
// ============================================================================

/** A subscription as the local store holds it (what the sidebar renders). */
function findSubscription(id: string): Record<string, unknown> | undefined {
  return getLocalDb(queryClient).subscriptions.rows.getSynced(id);
}

/** The unread count the sidebar shows for a subscription. */
function getSidebarUnreadCount(id: string): number | undefined {
  return getLocalDb(queryClient).subscriptions.rows.getSynced(id)?.unreadCount;
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

/** An entry as rendered from the local store (undefined when not held). */
function storedEntry(id: string): EntryRow | undefined {
  return getLocalDb(queryClient).entries.collection.get(id);
}

/** Every list row, as the entry it shows (an entry in two lists appears twice). */
function listedEntries(): EntryRow[] {
  return getLocalDb(queryClient)
    .lists.rows.collection.toArray.map((row) => storedEntry(row.entryId))
    .filter((entry): entry is EntryRow => entry !== undefined);
}

/** The ids a loaded list shows, sorted (ordering is covered in entry-lists.test). */
function listIds(input: Record<string, unknown>): string[] {
  const listKey = entryListKey(input);
  return getLocalDb(queryClient)
    .lists.rows.collection.toArray.filter((row) => row.listKey === listKey)
    .map((row) => row.entryId)
    .sort();
}

function seedList(input: Record<string, unknown>, items: unknown[]): void {
  queryClient.setQueryData([["entries", "list"], { input, type: "infinite" }], {
    pages: [{ items, nextCursor: undefined }],
    pageParams: [undefined],
  });
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

    expect(getSidebarUnreadCount("sub-1")).toBe(6); // set

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
    expect(getSidebarUnreadCount("sub-1")).toBe(5); // unchanged
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
    expect(getSidebarUnreadCount("sub-1")).toBe(5);
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

    expect(getSidebarUnreadCount("sub-1")).toBe(6); // not 7
    const tagsList = getTagsList();
    expect(tagsList?.items.find((t) => t.id === "tag-1")?.unreadCount).toBe(16); // not 17
    expect(getEntriesCount({})?.unread).toBe(19); // not 20
  });

  it("inserts the entry into loaded lists when the event carries list data", () => {
    const before = listedEntries().length;

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

    const inserted = storedEntry("entry-live");
    expect(listedEntries()).toHaveLength(before + 1);
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

    const copies = listedEntries().filter((e) => e.id === "entry-live");
    expect(copies).toHaveLength(1);
  });

  it("leaves lists unchanged when the event has no list data (older server)", () => {
    const before = listedEntries().length;

    handleSyncEvent(
      utils,
      queryClient,
      createNewEntryEvent({ entryId: "entry-live", subscriptionId: "sub-1" })
    );

    expect(listedEntries()).toHaveLength(before);
    expect(storedEntry("entry-live")).toBeUndefined();
  });
});

// ============================================================================
// entry_updated Events
// ============================================================================

describe("handleSyncEvent - entry_updated", () => {
  it("updates the stored entry's metadata", () => {
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

    const entry = storedEntry("entry-1");
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

    expect(storedEntry("entry-1")?.publishedAt).toBeNull();
  });

  it("isn't undone by a list page fetched before the update landing after it", () => {
    handleSyncEvent(utils, queryClient, createEntryUpdatedEvent({ entryId: "entry-1" }));

    // The page's read state is newer than anything stored, its metadata isn't.
    const entry1 = DEFAULT_ENTRIES.find((e) => e.id === "entry-1");
    seedList({ limit: 50 }, [
      { ...entry1, read: true, updatedAt: new Date("2024-06-15T00:00:00.000Z") },
    ]);

    expect(storedEntry("entry-1")).toMatchObject({
      title: "Updated Title",
      summary: "Updated Summary",
      read: true,
    });
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

    expect(storedEntry("non-existent-entry")).toBeUndefined();
  });
});

// ============================================================================
// entry_state_changed Events
// ============================================================================

describe("handleSyncEvent - entry_state_changed", () => {
  it("restores an entry that became unread into unreadOnly lists missing it", () => {
    // entry-3 is read in the seeded "All" list. An unreadOnly list fetched
    // while it was read doesn't contain it; marking it unread (e.g. on
    // another device) must insert it there, not just update its state.
    seedList({ unreadOnly: true, limit: 25 }, [DEFAULT_ENTRIES.find((e) => e.id === "entry-1")]);

    handleSyncEvent(
      utils,
      queryClient,
      createEntryStateChangedEvent({
        entryId: "entry-3",
        read: false,
        starred: false,
      })
    );

    expect(listIds({ unreadOnly: true, limit: 25 })).toEqual(["entry-1", "entry-3"]);
    expect(storedEntry("entry-3")?.read).toBe(false);
  });

  it("inserts an entry the store doesn't hold from the event's list payload (#1237)", () => {
    // The entry was marked unread on another device (or via MCP) and this
    // client doesn't hold it at all — every list was fetched while it was
    // read and filtered out. The event's list-item payload (mirroring
    // new_entry) is what makes it appear.
    seedList({ unreadOnly: true, limit: 25 }, [DEFAULT_ENTRIES.find((e) => e.id === "entry-1")]);
    expect(storedEntry("entry-uncached")).toBeUndefined();

    handleSyncEvent(
      utils,
      queryClient,
      createEntryStateChangedEvent({
        entryId: "entry-uncached",
        read: false,
        starred: false,
        subscriptionId: "sub-1",
        feedId: "feed-1",
        feedType: "web",
        updatedAt: "2024-07-01T00:00:00.000Z",
        entry: {
          url: "https://example.com/uncached",
          title: "Uncached Entry",
          author: null,
          summary: null,
          publishedAt: "2024-06-02T12:00:00.000Z",
          fetchedAt: "2024-06-02T12:00:00.000Z",
          siteName: null,
          feedTitle: "Feed One",
        },
      })
    );

    expect(listIds({ unreadOnly: true, limit: 25 })).toEqual(["entry-1", "entry-uncached"]);

    const inserted = storedEntry("entry-uncached");
    expect(inserted).toMatchObject({
      id: "entry-uncached",
      subscriptionId: "sub-1",
      feedId: "feed-1",
      type: "web",
      title: "Uncached Entry",
      feedTitle: "Feed One",
      read: false,
      starred: false,
    });
    // Date strings from the event become Date objects like a real list response
    expect(inserted?.publishedAt).toBeInstanceOf(Date);
    expect(inserted?.fetchedAt).toBeInstanceOf(Date);
    expect(inserted?.updatedAt).toBeInstanceOf(Date);
  });

  it("is idempotent: applying the same payload event twice inserts one row", () => {
    const event = createEntryStateChangedEvent({
      entryId: "entry-uncached",
      read: false,
      starred: false,
      subscriptionId: "sub-1",
      feedId: "feed-1",
      feedType: "web",
      entry: {
        url: null,
        title: "Uncached Entry",
        author: null,
        summary: null,
        publishedAt: "2024-06-02T12:00:00.000Z",
        fetchedAt: "2024-06-02T12:00:00.000Z",
        siteName: null,
        feedTitle: "Feed One",
      },
    });

    handleSyncEvent(utils, queryClient, event);
    handleSyncEvent(utils, queryClient, event);

    const copies = listedEntries().filter((e) => e.id === "entry-uncached");
    expect(copies).toHaveLength(1);
  });

  it("inserts an unread starred payload entry into starredOnly lists too", () => {
    seedList({ starredOnly: true, limit: 25 }, []);

    handleSyncEvent(
      utils,
      queryClient,
      createEntryStateChangedEvent({
        entryId: "entry-uncached",
        read: false,
        starred: true,
        subscriptionId: "sub-1",
        feedId: "feed-1",
        feedType: "web",
        entry: {
          url: null,
          title: "Starred Uncached Entry",
          author: null,
          summary: null,
          publishedAt: "2024-06-02T12:00:00.000Z",
          fetchedAt: "2024-06-02T12:00:00.000Z",
          siteName: null,
          feedTitle: "Feed One",
        },
      })
    );

    expect(listIds({ starredOnly: true, limit: 25 })).toEqual(["entry-uncached"]);
  });

  it("does not insert a payload-less unread event for an entry the store doesn't hold (older server)", () => {
    const before = listedEntries().length;

    handleSyncEvent(
      utils,
      queryClient,
      createEntryStateChangedEvent({
        entryId: "entry-uncached",
        read: false,
        starred: false,
      })
    );

    // Nothing to insert from — the entry appears on the next navigation refresh.
    expect(listedEntries()).toHaveLength(before);
    expect(storedEntry("entry-uncached")).toBeUndefined();
  });

  it("updates the stored read and starred state", () => {
    handleSyncEvent(
      utils,
      queryClient,
      createEntryStateChangedEvent({
        entryId: "entry-1",
        read: true,
        starred: true,
      })
    );

    const entry = storedEntry("entry-1");
    expect(entry?.read).toBe(true);
    expect(entry?.starred).toBe(true);
  });

  it("updates the stored starred state alone", () => {
    handleSyncEvent(
      utils,
      queryClient,
      createEntryStateChangedEvent({
        entryId: "entry-2",
        read: false,
        starred: true,
      })
    );

    const entry = storedEntry("entry-2");
    expect(entry?.starred).toBe(true);
    expect(entry?.read).toBe(false);
  });

  it("ignores state older than what the store holds", () => {
    handleSyncEvent(
      utils,
      queryClient,
      createEntryStateChangedEvent({
        entryId: "entry-1",
        read: true,
        starred: false,
        updatedAt: "2024-01-01T00:00:00.000Z",
      })
    );

    expect(storedEntry("entry-1")).toMatchObject({ read: false, starred: true });
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

    expect(getSidebarUnreadCount("sub-1")).toBe(5); // unchanged
    expect(getEntriesCount({})?.unread).toBe(18); // unchanged
    expect(getEntriesCount({ starredOnly: true })?.unread).toBe(2); // unchanged
  });
});

// ============================================================================
// mark_all_read Events
// ============================================================================

describe("handleSyncEvent - mark_all_read", () => {
  it("sets the counts it carries and refetches only the entry lists", () => {
    handleSyncEvent(
      utils,
      queryClient,
      createMarkAllReadEvent({
        counts: {
          all: { unread: 3 },
          starred: { unread: 0 },
          saved: { unread: 0 },
          subscriptions: [{ id: "sub-1", unread: 0, tagIds: ["tag-1"] }],
          tags: [{ id: "tag-1", unread: 10 }],
        },
      })
    );

    expect(getSidebarUnreadCount("sub-1")).toBe(0);
    expect(getTagsList()?.items.find((tag) => tag.id === "tag-1")?.unreadCount).toBe(10);
    expect(getEntriesCount()).toEqual({ unread: 3 });
    // The one SSE event that deliberately refetches entries.list.
    expect(invalidatedProcedures(invalidateSpy)).toEqual(["entries.list"]);
  });

  it("refetches the counts instead for a previous release's event, which has none", () => {
    handleSyncEvent(utils, queryClient, createMarkAllReadEvent());

    expect(invalidatedProcedures(invalidateSpy).sort()).toEqual([
      "entries.count",
      "entries.list",
      "subscriptions.get",
      "subscriptions.list",
      "tags.list",
    ]);
  });

  it("does not touch entry read state directly (invalidation handles it)", () => {
    // entry-1/entry-2 stay as-is in the cache; the refetch (not a direct patch)
    // is what will mark them read, so the handler itself changes nothing.
    handleSyncEvent(utils, queryClient, createMarkAllReadEvent());

    expect(storedEntry("entry-1")?.read).toBe(false);
    expect(storedEntry("entry-2")?.read).toBe(false);
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

    const newSub = findSubscription("sub-new");
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

    const newSub = findSubscription("sub-new");
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

    const sub1 = findSubscription("sub-1");
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

    const sub1 = findSubscription("sub-1");
    expect((sub1 as Record<string, unknown>)?.title).toBe("Custom Name");
  });

  it("reverts to the feed's own title when customTitle is cleared", () => {
    const update = (customTitle: string | null) =>
      handleSyncEvent(
        utils,
        queryClient,
        createSubscriptionUpdatedEvent({
          subscriptionId: "sub-1",
          tags: [{ id: "tag-1", name: "Tech", color: "#ff0000" }],
          customTitle,
        })
      );

    update("Custom Name");
    update(null);

    expect(findSubscription("sub-1")?.title).toBe(DEFAULT_SUBSCRIPTIONS[0].originalTitle);
  });

  it("refetches tag feed counts and the collection picker, not the sidebar sections", () => {
    invalidateSpy.mockClear();
    handleSyncEvent(utils, queryClient, createSubscriptionUpdatedEvent());

    expect(invalidatedQueries(invalidateSpy)).toEqual([
      { path: "tags.list", input: undefined },
      { path: "subscriptions.list", input: { type: "collection" } },
    ]);
  });

  it("loads an unstored subscription it moves into a loaded section, not into a collapsed one", () => {
    const fetchSpy = vi.spyOn(queryClient, "fetchQuery").mockResolvedValue(undefined);
    const fetchedIds = () =>
      fetchSpy.mock.calls.map(
        ([options]) => (options.queryKey[1] as { input: { id: string } }).input.id
      );

    handleSyncEvent(
      utils,
      queryClient,
      createSubscriptionUpdatedEvent({
        subscriptionId: "sub-new",
        tags: [{ id: "tag-x", name: "X", color: null }],
      })
    );
    expect(fetchedIds()).toEqual([]);

    handleSyncEvent(
      utils,
      queryClient,
      createSubscriptionUpdatedEvent({
        subscriptionId: "sub-new",
        tags: [{ id: "tag-1", name: "Tech", color: null }],
      })
    );
    expect(fetchedIds()).toEqual(["sub-new"]);
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

    expect(findSubscription("sub-1")).toBeUndefined();

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

    expect(findSubscription("sub-2")).toBeUndefined();

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
    expect(findSubscription("sub-1")).toBeUndefined();
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

  it("still applies counts + invalidates entries.list when the subscription is not cached (#1081)", () => {
    // A delete for a subscription that was never cached (e.g. tags collapsed, so
    // its per-tag subscriptions.list was never loaded) must NOT be skipped: the
    // event still carries absolute counts and the deleted feed's entries must be
    // dropped from the list. Only the structural removal is skipped.
    setUtilsData(utils.entries.count, {}, { unread: 22 });

    handleSyncEvent(
      utils,
      queryClient,
      createSubscriptionDeletedEvent({
        subscriptionId: "sub-unknown",
        counts: {
          all: { unread: 12 },
          starred: { unread: 1 },
          subscriptions: [],
          tags: [],
        },
      })
    );

    // Absolute counts from the event are applied even though nothing was removed.
    expect(getEntriesCount({})?.unread).toBe(12);
    // entries.list is invalidated so the deleted feed's entries are re-filtered.
    expect(invalidatedProcedures(invalidateSpy)).toContain("entries.list");
  });

  it("invalidates count caches + entries.list for an uncached subscription with no counts (sync catch-up)", () => {
    invalidateSpy.mockClear();
    handleSyncEvent(
      utils,
      queryClient,
      createSubscriptionDeletedEvent({
        subscriptionId: "sub-unknown",
      })
    );

    // No counts on the event → invalidate the count caches and entries.list
    // rather than silently doing nothing.
    const paths = invalidatedProcedures(invalidateSpy);
    expect(paths).toContain("tags.list");
    expect(paths).toContain("entries.count");
    expect(paths).toContain("entries.list");
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
    expect(getSidebarUnreadCount("sub-1")).toBe(4);

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
    expect(getSidebarUnreadCount("sub-2")).toBe(2);

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
    expect(getSidebarUnreadCount("sub-2")).toBe(4);

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
    expect(getSidebarUnreadCount("sub-1")).toBe(5);
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
    expect(getSidebarUnreadCount("sub-1")).toBe(4); // -1
    expect(getSidebarUnreadCount("sub-2")).toBe(3); // unchanged
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
    expect(getSidebarUnreadCount("sub-1")).toBe(5);
    expect(getSidebarUnreadCount("sub-2")).toBe(3);

    // Tag counts unchanged
    const tagsList = getTagsList();
    expect(tagsList?.items.find((t) => t.id === "tag-1")?.unreadCount).toBe(15);
    expect(tagsList?.uncategorized.unreadCount).toBe(3);
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

    // Subscription/tag/saved counts unchanged (orphaned entry has no subscription)
    expect(getSidebarUnreadCount("sub-1")).toBe(5);
    const tagsList = getTagsList();
    expect(tagsList?.items.find((t) => t.id === "tag-1")?.unreadCount).toBe(15);
    expect(tagsList?.items.find((t) => t.id === "tag-2")?.unreadCount).toBe(10);
    expect(tagsList?.uncategorized.unreadCount).toBe(3);
    expect(getEntriesCount({ type: "saved" })?.unread).toBe(1);
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
    expect(getSidebarUnreadCount("sub-3")).toBe(9);

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

    expect(getSidebarUnreadCount("sub-1")).toBe(6);
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
    expect(getSidebarUnreadCount("sub-1")).toBe(5);
    expect(getEntriesCount({})?.unread).toBe(18);
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

    expect(findSubscription("sub-temp")).toBeUndefined();
    expect(getEntriesCount({})?.unread).toBe(18); // back to original
  });
});

/**
 * Unit tests for TanStack DB collection write functions.
 *
 * Tests use real TanStack DB collections (local-only) to verify that
 * collection writes behave correctly for optimistic updates, SSE handling,
 * and mark-all-read operations.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { createSubscriptionsCollection } from "@/lib/collections/subscriptions";
import { createEntriesCollection } from "@/lib/collections/entries";
import { createCountsCollection } from "@/lib/collections/counts";
import type { Collections } from "@/lib/collections";
import type { Subscription, EntryListItem } from "@/lib/collections/types";
import {
  zeroSubscriptionUnreadForMarkAllRead,
  upsertEntriesInCollection,
  updateEntryReadInCollection,
  updateEntryStarredInCollection,
  adjustEntriesCountInCollection,
  setEntriesCountInCollection,
  adjustSubscriptionUnreadInCollection,
  setSubscriptionUnreadInCollection,
  setBulkSubscriptionUnreadInCollection,
  addSubscriptionToCollection,
  removeSubscriptionFromCollection,
  upsertSubscriptionsInCollection,
  updateEntryScoreInCollection,
  updateEntryMetadataInCollection,
  adjustUncategorizedUnreadInCollection,
  adjustUncategorizedFeedCountInCollection,
  setUncategorizedUnreadInCollection,
} from "@/lib/collections/writes";

// ---------------------------------------------------------------------------
// Test Helpers
// ---------------------------------------------------------------------------

function createTestSubscription(overrides: Partial<Subscription> = {}): Subscription {
  return {
    id: "sub-1",
    type: "web",
    url: "https://example.com/feed.xml",
    title: "Example Feed",
    originalTitle: "Example Feed",
    description: "An example feed",
    siteUrl: "https://example.com",
    subscribedAt: new Date("2024-01-01"),
    unreadCount: 10,
    totalCount: 50,
    tags: [],
    fetchFullContent: false,
    ...overrides,
  } as Subscription;
}

function createTestEntry(overrides: Partial<EntryListItem> = {}): EntryListItem {
  return {
    id: "entry-1",
    subscriptionId: "sub-1",
    feedId: "feed-1",
    type: "web",
    url: "https://example.com/post-1",
    title: "Test Post",
    author: "Author",
    summary: "A test post",
    publishedAt: new Date("2024-06-01"),
    fetchedAt: new Date("2024-06-01"),
    updatedAt: new Date("2024-06-01"),
    read: false,
    starred: false,
    feedTitle: "Example Feed",
    siteName: "example.com",
    score: null,
    implicitScore: 0,
    predictedScore: null,
    ...overrides,
  } as EntryListItem;
}

/**
 * Creates a minimal Collections object with real local-only collections.
 * Tags collection is omitted since it requires a QueryClient; tests that
 * need tags should create one separately.
 */
function createTestCollections(): Collections {
  return {
    subscriptions: createSubscriptionsCollection(),
    // Tags requires a QueryClient; cast a stub for tests that don't use it
    tags: undefined as unknown as Collections["tags"],
    entries: createEntriesCollection(),
    counts: createCountsCollection(),
    activeViewCollection: null,
    invalidateActiveView: () => {},
  };
}

// ============================================================================
// zeroSubscriptionUnreadForMarkAllRead
// ============================================================================

describe("zeroSubscriptionUnreadForMarkAllRead", () => {
  let collections: Collections;

  beforeEach(() => {
    collections = createTestCollections();
  });

  it("zeroes all subscriptions when no filter is provided", () => {
    collections.subscriptions.insert(createTestSubscription({ id: "sub-1", unreadCount: 10 }));
    collections.subscriptions.insert(createTestSubscription({ id: "sub-2", unreadCount: 5 }));
    collections.subscriptions.insert(createTestSubscription({ id: "sub-3", unreadCount: 20 }));

    zeroSubscriptionUnreadForMarkAllRead(collections, {});

    expect(collections.subscriptions.get("sub-1")?.unreadCount).toBe(0);
    expect(collections.subscriptions.get("sub-2")?.unreadCount).toBe(0);
    expect(collections.subscriptions.get("sub-3")?.unreadCount).toBe(0);
  });

  it("zeroes only the specified subscription when subscriptionId filter is provided", () => {
    collections.subscriptions.insert(createTestSubscription({ id: "sub-1", unreadCount: 10 }));
    collections.subscriptions.insert(createTestSubscription({ id: "sub-2", unreadCount: 5 }));

    zeroSubscriptionUnreadForMarkAllRead(collections, { subscriptionId: "sub-1" });

    expect(collections.subscriptions.get("sub-1")?.unreadCount).toBe(0);
    expect(collections.subscriptions.get("sub-2")?.unreadCount).toBe(5);
  });

  it("zeroes subscriptions matching the tagId filter", () => {
    const tag = { id: "tag-1", name: "News", color: "#ff0000" };
    collections.subscriptions.insert(
      createTestSubscription({ id: "sub-1", unreadCount: 10, tags: [tag] })
    );
    collections.subscriptions.insert(
      createTestSubscription({ id: "sub-2", unreadCount: 5, tags: [tag] })
    );
    collections.subscriptions.insert(
      createTestSubscription({ id: "sub-3", unreadCount: 20, tags: [] })
    );

    zeroSubscriptionUnreadForMarkAllRead(collections, { tagId: "tag-1" });

    expect(collections.subscriptions.get("sub-1")?.unreadCount).toBe(0);
    expect(collections.subscriptions.get("sub-2")?.unreadCount).toBe(0);
    // Sub-3 has no matching tag, should be untouched
    expect(collections.subscriptions.get("sub-3")?.unreadCount).toBe(20);
  });

  it("does not touch subscriptions that already have zero unread count", () => {
    collections.subscriptions.insert(createTestSubscription({ id: "sub-1", unreadCount: 0 }));
    collections.subscriptions.insert(createTestSubscription({ id: "sub-2", unreadCount: 5 }));

    // This should not throw or cause issues for already-zero subscriptions
    zeroSubscriptionUnreadForMarkAllRead(collections, {});

    expect(collections.subscriptions.get("sub-1")?.unreadCount).toBe(0);
    expect(collections.subscriptions.get("sub-2")?.unreadCount).toBe(0);
  });

  it("is a no-op when collections is null", () => {
    // Should not throw
    zeroSubscriptionUnreadForMarkAllRead(null, {});
    zeroSubscriptionUnreadForMarkAllRead(null, { subscriptionId: "sub-1" });
    zeroSubscriptionUnreadForMarkAllRead(null, { tagId: "tag-1" });
  });

  it("handles subscriptionId that does not exist in the collection", () => {
    collections.subscriptions.insert(createTestSubscription({ id: "sub-1", unreadCount: 10 }));

    // Should not throw for non-existent subscription
    zeroSubscriptionUnreadForMarkAllRead(collections, { subscriptionId: "non-existent" });

    // Existing subscription should be untouched
    expect(collections.subscriptions.get("sub-1")?.unreadCount).toBe(10);
  });

  it("handles tagId with no matching subscriptions", () => {
    collections.subscriptions.insert(
      createTestSubscription({ id: "sub-1", unreadCount: 10, tags: [] })
    );

    zeroSubscriptionUnreadForMarkAllRead(collections, { tagId: "non-existent-tag" });

    expect(collections.subscriptions.get("sub-1")?.unreadCount).toBe(10);
  });

  it("only zeroes subscriptions whose tag array contains the specified tag", () => {
    const tagA = { id: "tag-a", name: "Tag A", color: null };
    const tagB = { id: "tag-b", name: "Tag B", color: null };

    collections.subscriptions.insert(
      createTestSubscription({ id: "sub-1", unreadCount: 10, tags: [tagA, tagB] })
    );
    collections.subscriptions.insert(
      createTestSubscription({ id: "sub-2", unreadCount: 5, tags: [tagB] })
    );
    collections.subscriptions.insert(
      createTestSubscription({ id: "sub-3", unreadCount: 3, tags: [tagA] })
    );

    zeroSubscriptionUnreadForMarkAllRead(collections, { tagId: "tag-a" });

    expect(collections.subscriptions.get("sub-1")?.unreadCount).toBe(0);
    expect(collections.subscriptions.get("sub-2")?.unreadCount).toBe(5); // only has tag-b
    expect(collections.subscriptions.get("sub-3")?.unreadCount).toBe(0);
  });
});

// ============================================================================
// upsertEntriesInCollection
// ============================================================================

describe("upsertEntriesInCollection", () => {
  let collections: Collections;

  beforeEach(() => {
    collections = createTestCollections();
  });

  it("inserts new entries into the global entries collection", () => {
    const entry1 = createTestEntry({ id: "entry-1" });
    const entry2 = createTestEntry({ id: "entry-2", title: "Second Post" });

    upsertEntriesInCollection(collections, [entry1, entry2]);

    expect(collections.entries.has("entry-1")).toBe(true);
    expect(collections.entries.has("entry-2")).toBe(true);
    expect(collections.entries.get("entry-1")?.title).toBe("Test Post");
    expect(collections.entries.get("entry-2")?.title).toBe("Second Post");
  });

  it("updates existing entries in the collection", () => {
    const entry = createTestEntry({ id: "entry-1", title: "Original Title", read: false });
    collections.entries.insert(entry);

    const updatedEntry = createTestEntry({ id: "entry-1", title: "Updated Title", read: true });
    upsertEntriesInCollection(collections, [updatedEntry]);

    expect(collections.entries.get("entry-1")?.title).toBe("Updated Title");
    expect(collections.entries.get("entry-1")?.read).toBe(true);
  });

  it("handles a mix of new and existing entries", () => {
    const existing = createTestEntry({ id: "entry-1", title: "Existing" });
    collections.entries.insert(existing);

    const updatedExisting = createTestEntry({ id: "entry-1", title: "Updated Existing" });
    const newEntry = createTestEntry({ id: "entry-2", title: "Brand New" });

    upsertEntriesInCollection(collections, [updatedExisting, newEntry]);

    expect(collections.entries.get("entry-1")?.title).toBe("Updated Existing");
    expect(collections.entries.get("entry-2")?.title).toBe("Brand New");
  });

  it("is a no-op when collections is null", () => {
    upsertEntriesInCollection(null, [createTestEntry()]);
    // Should not throw
  });

  it("is a no-op for empty entries array", () => {
    upsertEntriesInCollection(collections, []);
    expect(collections.entries.size).toBe(0);
  });
});

// ============================================================================
// updateEntryReadInCollection
// ============================================================================

describe("updateEntryReadInCollection", () => {
  let collections: Collections;

  beforeEach(() => {
    collections = createTestCollections();
  });

  it("marks entries as read in the global entries collection", () => {
    collections.entries.insert(createTestEntry({ id: "entry-1", read: false }));
    collections.entries.insert(createTestEntry({ id: "entry-2", read: false }));

    updateEntryReadInCollection(collections, ["entry-1", "entry-2"], true);

    expect(collections.entries.get("entry-1")?.read).toBe(true);
    expect(collections.entries.get("entry-2")?.read).toBe(true);
  });

  it("marks entries as unread in the global entries collection", () => {
    collections.entries.insert(createTestEntry({ id: "entry-1", read: true }));

    updateEntryReadInCollection(collections, ["entry-1"], false);

    expect(collections.entries.get("entry-1")?.read).toBe(false);
  });

  it("skips entries that do not exist in the collection", () => {
    collections.entries.insert(createTestEntry({ id: "entry-1", read: false }));

    // "entry-2" does not exist, should not throw
    updateEntryReadInCollection(collections, ["entry-1", "entry-2"], true);

    expect(collections.entries.get("entry-1")?.read).toBe(true);
    expect(collections.entries.has("entry-2")).toBe(false);
  });

  it("is a no-op when collections is null", () => {
    updateEntryReadInCollection(null, ["entry-1"], true);
    // Should not throw
  });

  it("is a no-op for empty entryIds array", () => {
    collections.entries.insert(createTestEntry({ id: "entry-1", read: false }));

    updateEntryReadInCollection(collections, [], true);

    expect(collections.entries.get("entry-1")?.read).toBe(false);
  });
});

// ============================================================================
// updateEntryStarredInCollection
// ============================================================================

describe("updateEntryStarredInCollection", () => {
  let collections: Collections;

  beforeEach(() => {
    collections = createTestCollections();
  });

  it("stars an entry in the global entries collection", () => {
    collections.entries.insert(createTestEntry({ id: "entry-1", starred: false }));

    updateEntryStarredInCollection(collections, "entry-1", true);

    expect(collections.entries.get("entry-1")?.starred).toBe(true);
  });

  it("unstars an entry in the global entries collection", () => {
    collections.entries.insert(createTestEntry({ id: "entry-1", starred: true }));

    updateEntryStarredInCollection(collections, "entry-1", false);

    expect(collections.entries.get("entry-1")?.starred).toBe(false);
  });

  it("skips entry that does not exist in the collection", () => {
    // Should not throw
    updateEntryStarredInCollection(collections, "non-existent", true);
  });

  it("is a no-op when collections is null", () => {
    updateEntryStarredInCollection(null, "entry-1", true);
    // Should not throw
  });
});

// ============================================================================
// adjustEntriesCountInCollection
// ============================================================================

describe("adjustEntriesCountInCollection", () => {
  let collections: Collections;

  beforeEach(() => {
    collections = createTestCollections();
  });

  it("adjusts total and unread counts for an existing count record", () => {
    collections.counts.insert({ id: "all", total: 100, unread: 50 });

    adjustEntriesCountInCollection(collections, "all", 1, 1);

    expect(collections.counts.get("all")?.total).toBe(101);
    expect(collections.counts.get("all")?.unread).toBe(51);
  });

  it("decreases counts but floors at zero", () => {
    collections.counts.insert({ id: "all", total: 1, unread: 0 });

    adjustEntriesCountInCollection(collections, "all", -5, -5);

    expect(collections.counts.get("all")?.total).toBe(0);
    expect(collections.counts.get("all")?.unread).toBe(0);
  });

  it("does not create a count record that does not exist", () => {
    // "all" not inserted, so this should be a no-op
    adjustEntriesCountInCollection(collections, "all", 1, 1);

    expect(collections.counts.has("all")).toBe(false);
  });

  it("is a no-op when both deltas are zero", () => {
    collections.counts.insert({ id: "all", total: 100, unread: 50 });

    adjustEntriesCountInCollection(collections, "all", 0, 0);

    expect(collections.counts.get("all")?.total).toBe(100);
    expect(collections.counts.get("all")?.unread).toBe(50);
  });

  it("is a no-op when collections is null", () => {
    adjustEntriesCountInCollection(null, "all", 1, 1);
    // Should not throw
  });

  it("works with starred and saved keys", () => {
    collections.counts.insert({ id: "starred", total: 10, unread: 5 });
    collections.counts.insert({ id: "saved", total: 20, unread: 10 });

    adjustEntriesCountInCollection(collections, "starred", 2, 1);
    adjustEntriesCountInCollection(collections, "saved", -3, -2);

    expect(collections.counts.get("starred")?.total).toBe(12);
    expect(collections.counts.get("starred")?.unread).toBe(6);
    expect(collections.counts.get("saved")?.total).toBe(17);
    expect(collections.counts.get("saved")?.unread).toBe(8);
  });
});

// ============================================================================
// setEntriesCountInCollection
// ============================================================================

describe("setEntriesCountInCollection", () => {
  let collections: Collections;

  beforeEach(() => {
    collections = createTestCollections();
  });

  it("creates a count record that does not exist yet", () => {
    setEntriesCountInCollection(collections, "all", 100, 50);

    expect(collections.counts.has("all")).toBe(true);
    expect(collections.counts.get("all")?.total).toBe(100);
    expect(collections.counts.get("all")?.unread).toBe(50);
  });

  it("updates an existing count record", () => {
    collections.counts.insert({ id: "all", total: 50, unread: 25 });

    setEntriesCountInCollection(collections, "all", 100, 50);

    expect(collections.counts.get("all")?.total).toBe(100);
    expect(collections.counts.get("all")?.unread).toBe(50);
  });

  it("is a no-op when collections is null", () => {
    setEntriesCountInCollection(null, "all", 100, 50);
    // Should not throw
  });
});

// ============================================================================
// adjustSubscriptionUnreadInCollection
// ============================================================================

describe("adjustSubscriptionUnreadInCollection", () => {
  let collections: Collections;

  beforeEach(() => {
    collections = createTestCollections();
  });

  it("adjusts unread count for subscriptions by delta", () => {
    collections.subscriptions.insert(createTestSubscription({ id: "sub-1", unreadCount: 10 }));

    const deltas = new Map([["sub-1", -3]]);
    adjustSubscriptionUnreadInCollection(collections, deltas);

    expect(collections.subscriptions.get("sub-1")?.unreadCount).toBe(7);
  });

  it("floors unread count at zero", () => {
    collections.subscriptions.insert(createTestSubscription({ id: "sub-1", unreadCount: 2 }));

    const deltas = new Map([["sub-1", -10]]);
    adjustSubscriptionUnreadInCollection(collections, deltas);

    expect(collections.subscriptions.get("sub-1")?.unreadCount).toBe(0);
  });

  it("handles multiple subscriptions at once", () => {
    collections.subscriptions.insert(createTestSubscription({ id: "sub-1", unreadCount: 10 }));
    collections.subscriptions.insert(createTestSubscription({ id: "sub-2", unreadCount: 5 }));

    const deltas = new Map([
      ["sub-1", -2],
      ["sub-2", 3],
    ]);
    adjustSubscriptionUnreadInCollection(collections, deltas);

    expect(collections.subscriptions.get("sub-1")?.unreadCount).toBe(8);
    expect(collections.subscriptions.get("sub-2")?.unreadCount).toBe(8);
  });

  it("skips subscriptions not in the collection", () => {
    const deltas = new Map([["non-existent", -1]]);
    // Should not throw
    adjustSubscriptionUnreadInCollection(collections, deltas);
  });

  it("is a no-op when collections is null", () => {
    adjustSubscriptionUnreadInCollection(null, new Map([["sub-1", 1]]));
  });

  it("is a no-op for empty deltas map", () => {
    collections.subscriptions.insert(createTestSubscription({ id: "sub-1", unreadCount: 10 }));
    adjustSubscriptionUnreadInCollection(collections, new Map());
    expect(collections.subscriptions.get("sub-1")?.unreadCount).toBe(10);
  });
});

// ============================================================================
// setSubscriptionUnreadInCollection
// ============================================================================

describe("setSubscriptionUnreadInCollection", () => {
  let collections: Collections;

  beforeEach(() => {
    collections = createTestCollections();
  });

  it("sets absolute unread count for a subscription", () => {
    collections.subscriptions.insert(createTestSubscription({ id: "sub-1", unreadCount: 10 }));

    setSubscriptionUnreadInCollection(collections, "sub-1", 42);

    expect(collections.subscriptions.get("sub-1")?.unreadCount).toBe(42);
  });

  it("skips subscription not in collection", () => {
    setSubscriptionUnreadInCollection(collections, "non-existent", 5);
    // Should not throw
  });

  it("is a no-op when collections is null", () => {
    setSubscriptionUnreadInCollection(null, "sub-1", 5);
  });
});

// ============================================================================
// setBulkSubscriptionUnreadInCollection
// ============================================================================

describe("setBulkSubscriptionUnreadInCollection", () => {
  let collections: Collections;

  beforeEach(() => {
    collections = createTestCollections();
  });

  it("sets absolute unread counts for multiple subscriptions", () => {
    collections.subscriptions.insert(createTestSubscription({ id: "sub-1", unreadCount: 10 }));
    collections.subscriptions.insert(createTestSubscription({ id: "sub-2", unreadCount: 20 }));

    const updates = new Map([
      ["sub-1", 0],
      ["sub-2", 5],
    ]);
    setBulkSubscriptionUnreadInCollection(collections, updates);

    expect(collections.subscriptions.get("sub-1")?.unreadCount).toBe(0);
    expect(collections.subscriptions.get("sub-2")?.unreadCount).toBe(5);
  });

  it("skips subscriptions not in collection", () => {
    const updates = new Map([["non-existent", 5]]);
    setBulkSubscriptionUnreadInCollection(collections, updates);
    // Should not throw
  });

  it("is a no-op when collections is null", () => {
    setBulkSubscriptionUnreadInCollection(null, new Map([["sub-1", 5]]));
  });

  it("is a no-op for empty updates map", () => {
    collections.subscriptions.insert(createTestSubscription({ id: "sub-1", unreadCount: 10 }));
    setBulkSubscriptionUnreadInCollection(collections, new Map());
    expect(collections.subscriptions.get("sub-1")?.unreadCount).toBe(10);
  });
});

// ============================================================================
// addSubscriptionToCollection
// ============================================================================

describe("addSubscriptionToCollection", () => {
  let collections: Collections;

  beforeEach(() => {
    collections = createTestCollections();
  });

  it("adds a new subscription to the collection", () => {
    const sub = createTestSubscription({ id: "sub-1" });
    addSubscriptionToCollection(collections, sub);

    expect(collections.subscriptions.has("sub-1")).toBe(true);
    expect(collections.subscriptions.get("sub-1")?.title).toBe("Example Feed");
  });

  it("skips duplicate subscriptions (SSE race condition protection)", () => {
    const sub = createTestSubscription({ id: "sub-1", unreadCount: 10 });
    collections.subscriptions.insert(sub);

    // Attempt to add the same subscription again with different data
    const duplicate = createTestSubscription({ id: "sub-1", unreadCount: 99 });
    addSubscriptionToCollection(collections, duplicate);

    // Original should be preserved
    expect(collections.subscriptions.get("sub-1")?.unreadCount).toBe(10);
  });

  it("is a no-op when collections is null", () => {
    addSubscriptionToCollection(null, createTestSubscription());
  });
});

// ============================================================================
// removeSubscriptionFromCollection
// ============================================================================

describe("removeSubscriptionFromCollection", () => {
  let collections: Collections;

  beforeEach(() => {
    collections = createTestCollections();
  });

  it("removes a subscription from the collection", () => {
    collections.subscriptions.insert(createTestSubscription({ id: "sub-1" }));

    removeSubscriptionFromCollection(collections, "sub-1");

    expect(collections.subscriptions.has("sub-1")).toBe(false);
  });

  it("is a no-op for non-existent subscription", () => {
    removeSubscriptionFromCollection(collections, "non-existent");
    // Should not throw
  });

  it("is a no-op when collections is null", () => {
    removeSubscriptionFromCollection(null, "sub-1");
  });
});

// ============================================================================
// upsertSubscriptionsInCollection
// ============================================================================

describe("upsertSubscriptionsInCollection", () => {
  let collections: Collections;

  beforeEach(() => {
    collections = createTestCollections();
  });

  it("inserts new subscriptions into the collection", () => {
    const sub1 = createTestSubscription({ id: "sub-1" });
    const sub2 = createTestSubscription({ id: "sub-2", title: "Second Feed" });

    upsertSubscriptionsInCollection(collections, [sub1, sub2]);

    expect(collections.subscriptions.has("sub-1")).toBe(true);
    expect(collections.subscriptions.has("sub-2")).toBe(true);
    expect(collections.subscriptions.get("sub-2")?.title).toBe("Second Feed");
  });

  it("updates existing subscriptions in the collection", () => {
    collections.subscriptions.insert(
      createTestSubscription({ id: "sub-1", title: "Old Title", unreadCount: 5 })
    );

    const updated = createTestSubscription({ id: "sub-1", title: "New Title", unreadCount: 10 });
    upsertSubscriptionsInCollection(collections, [updated]);

    expect(collections.subscriptions.get("sub-1")?.title).toBe("New Title");
    expect(collections.subscriptions.get("sub-1")?.unreadCount).toBe(10);
  });

  it("handles a mix of new and existing subscriptions", () => {
    collections.subscriptions.insert(createTestSubscription({ id: "sub-1", title: "Existing" }));

    const updatedExisting = createTestSubscription({ id: "sub-1", title: "Updated" });
    const newSub = createTestSubscription({ id: "sub-2", title: "New" });

    upsertSubscriptionsInCollection(collections, [updatedExisting, newSub]);

    expect(collections.subscriptions.get("sub-1")?.title).toBe("Updated");
    expect(collections.subscriptions.get("sub-2")?.title).toBe("New");
  });

  it("is a no-op for empty array", () => {
    upsertSubscriptionsInCollection(collections, []);
    expect(collections.subscriptions.size).toBe(0);
  });

  it("is a no-op when collections is null", () => {
    upsertSubscriptionsInCollection(null, [createTestSubscription()]);
  });
});

// ============================================================================
// updateEntryScoreInCollection
// ============================================================================

describe("updateEntryScoreInCollection", () => {
  let collections: Collections;

  beforeEach(() => {
    collections = createTestCollections();
  });

  it("updates score fields for an entry", () => {
    collections.entries.insert(createTestEntry({ id: "entry-1", score: null, implicitScore: 0 }));

    updateEntryScoreInCollection(collections, "entry-1", 2, 2);

    expect(collections.entries.get("entry-1")?.score).toBe(2);
    expect(collections.entries.get("entry-1")?.implicitScore).toBe(2);
  });

  it("clears score to null", () => {
    collections.entries.insert(createTestEntry({ id: "entry-1", score: 2, implicitScore: 2 }));

    updateEntryScoreInCollection(collections, "entry-1", null, 0);

    expect(collections.entries.get("entry-1")?.score).toBeNull();
    expect(collections.entries.get("entry-1")?.implicitScore).toBe(0);
  });

  it("skips entry that does not exist", () => {
    updateEntryScoreInCollection(collections, "non-existent", 1, 1);
    // Should not throw
  });

  it("is a no-op when collections is null", () => {
    updateEntryScoreInCollection(null, "entry-1", 1, 1);
  });
});

// ============================================================================
// updateEntryMetadataInCollection
// ============================================================================

describe("updateEntryMetadataInCollection", () => {
  let collections: Collections;

  beforeEach(() => {
    collections = createTestCollections();
  });

  it("updates metadata fields for an entry", () => {
    collections.entries.insert(
      createTestEntry({ id: "entry-1", title: "Old Title", author: "Old Author" })
    );

    updateEntryMetadataInCollection(collections, "entry-1", {
      title: "New Title",
      author: "New Author",
    });

    expect(collections.entries.get("entry-1")?.title).toBe("New Title");
    expect(collections.entries.get("entry-1")?.author).toBe("New Author");
  });

  it("partially updates metadata", () => {
    collections.entries.insert(
      createTestEntry({ id: "entry-1", title: "Original", summary: "Original Summary" })
    );

    updateEntryMetadataInCollection(collections, "entry-1", { title: "Updated" });

    expect(collections.entries.get("entry-1")?.title).toBe("Updated");
    expect(collections.entries.get("entry-1")?.summary).toBe("Original Summary");
  });

  it("skips entry that does not exist", () => {
    updateEntryMetadataInCollection(collections, "non-existent", { title: "New" });
    // Should not throw
  });

  it("is a no-op when collections is null", () => {
    updateEntryMetadataInCollection(null, "entry-1", { title: "New" });
  });
});

// ============================================================================
// Uncategorized Count Writes
// ============================================================================

describe("adjustUncategorizedUnreadInCollection", () => {
  let collections: Collections;

  beforeEach(() => {
    collections = createTestCollections();
    collections.counts.insert({ id: "uncategorized", total: 5, unread: 3 });
  });

  it("adjusts uncategorized unread count by delta", () => {
    adjustUncategorizedUnreadInCollection(collections, -1);
    expect(collections.counts.get("uncategorized")?.unread).toBe(2);
  });

  it("floors unread count at zero", () => {
    adjustUncategorizedUnreadInCollection(collections, -10);
    expect(collections.counts.get("uncategorized")?.unread).toBe(0);
  });

  it("is a no-op when delta is zero", () => {
    adjustUncategorizedUnreadInCollection(collections, 0);
    expect(collections.counts.get("uncategorized")?.unread).toBe(3);
  });

  it("is a no-op when collections is null", () => {
    adjustUncategorizedUnreadInCollection(null, -1);
  });

  it("is a no-op when uncategorized record does not exist", () => {
    const freshCollections = createTestCollections();
    adjustUncategorizedUnreadInCollection(freshCollections, -1);
    expect(freshCollections.counts.has("uncategorized")).toBe(false);
  });
});

describe("adjustUncategorizedFeedCountInCollection", () => {
  let collections: Collections;

  beforeEach(() => {
    collections = createTestCollections();
    collections.counts.insert({ id: "uncategorized", total: 5, unread: 3 });
  });

  it("adjusts uncategorized feed count by delta", () => {
    adjustUncategorizedFeedCountInCollection(collections, 1);
    expect(collections.counts.get("uncategorized")?.total).toBe(6);
  });

  it("floors feed count at zero", () => {
    adjustUncategorizedFeedCountInCollection(collections, -10);
    expect(collections.counts.get("uncategorized")?.total).toBe(0);
  });

  it("is a no-op when delta is zero", () => {
    adjustUncategorizedFeedCountInCollection(collections, 0);
    expect(collections.counts.get("uncategorized")?.total).toBe(5);
  });

  it("is a no-op when collections is null", () => {
    adjustUncategorizedFeedCountInCollection(null, 1);
  });
});

describe("setUncategorizedUnreadInCollection", () => {
  let collections: Collections;

  beforeEach(() => {
    collections = createTestCollections();
    collections.counts.insert({ id: "uncategorized", total: 5, unread: 3 });
  });

  it("sets absolute uncategorized unread count", () => {
    setUncategorizedUnreadInCollection(collections, 10);
    expect(collections.counts.get("uncategorized")?.unread).toBe(10);
  });

  it("does not affect total count", () => {
    setUncategorizedUnreadInCollection(collections, 10);
    expect(collections.counts.get("uncategorized")?.total).toBe(5);
  });

  it("is a no-op when uncategorized record does not exist", () => {
    const freshCollections = createTestCollections();
    setUncategorizedUnreadInCollection(freshCollections, 10);
    expect(freshCollections.counts.has("uncategorized")).toBe(false);
  });

  it("is a no-op when collections is null", () => {
    setUncategorizedUnreadInCollection(null, 10);
  });
});

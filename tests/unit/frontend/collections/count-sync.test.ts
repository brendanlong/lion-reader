/**
 * Unit tests for count syncing logic in createCollections.
 *
 * Tests verify that createCollections properly:
 * 1. Seeds counts from SSR-prefetched data when available
 * 2. Seeds uncategorized counts from prefetched tags.list data
 * 3. The query cache subscription syncs counts when entries.count queries
 *    resolve after initialization
 *
 * Uses a real QueryClient and real TanStack DB collections.
 */

import { describe, it, expect, afterEach } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { createCollections, type CreateCollectionsResult } from "@/lib/collections";
import { TRPC_TAGS_LIST_KEY, type TagsListResponse } from "@/lib/collections/tags";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** tRPC query key for tags.list (no input) */
const TAGS_LIST_KEY = TRPC_TAGS_LIST_KEY as unknown as readonly unknown[];

/** Build a tRPC entries.count query key with optional input */
function entriesCountKey(input?: Record<string, unknown>): readonly unknown[] {
  return [["entries", "count"], { input: input ?? {}, type: "query" }];
}

/** Build a mock TagsListResponse */
function mockTagsListResponse(overrides?: Partial<TagsListResponse>): TagsListResponse {
  return {
    items: [],
    uncategorized: { feedCount: 5, unreadCount: 3 },
    ...overrides,
  };
}

/**
 * Creates a test QueryClient, calls createCollections, and returns both.
 * The cleanup function is tracked for proper teardown.
 */
function setup(prefetch?: (queryClient: QueryClient) => void): {
  queryClient: QueryClient;
  result: CreateCollectionsResult;
} {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        // Disable retries and refetching for tests
        retry: false,
        staleTime: Infinity,
      },
    },
  });

  if (prefetch) {
    prefetch(queryClient);
  }

  const result = createCollections(queryClient, {
    fetchTagsAndUncategorized: async () => mockTagsListResponse(),
  });

  return { queryClient, result };
}

// Track created collections for cleanup
const createdResults: CreateCollectionsResult[] = [];

function setupTracked(prefetch?: (queryClient: QueryClient) => void): ReturnType<typeof setup> {
  const s = setup(prefetch);
  createdResults.push(s.result);
  return s;
}

afterEach(() => {
  // Clean up all created collections
  for (const result of createdResults) {
    result.cleanup();
  }
  createdResults.length = 0;
});

// ============================================================================
// SSR Prefetch Seeding - Uncategorized Counts
// ============================================================================

describe("SSR seeding: uncategorized counts from tags.list", () => {
  it("seeds uncategorized counts when tags.list data is prefetched", () => {
    const { result } = setupTracked((qc) => {
      qc.setQueryData(
        TAGS_LIST_KEY,
        mockTagsListResponse({
          uncategorized: { feedCount: 12, unreadCount: 7 },
        })
      );
    });

    const uncategorized = result.collections.counts.get("uncategorized");
    expect(uncategorized).toBeDefined();
    expect(uncategorized?.total).toBe(12);
    expect(uncategorized?.unread).toBe(7);
  });

  it("does not seed uncategorized counts when no tags.list data is prefetched", () => {
    const { result } = setupTracked();

    const uncategorized = result.collections.counts.get("uncategorized");
    expect(uncategorized).toBeUndefined();
  });
});

// ============================================================================
// SSR Prefetch Seeding - Entry Counts
// ============================================================================

describe("SSR seeding: entry counts from entries.count", () => {
  it("seeds 'all' count from prefetched entries.count with empty input", () => {
    const { result } = setupTracked((qc) => {
      qc.setQueryData(entriesCountKey({}), { total: 100, unread: 50 });
    });

    const allCount = result.collections.counts.get("all");
    expect(allCount).toBeDefined();
    expect(allCount?.total).toBe(100);
    expect(allCount?.unread).toBe(50);
  });

  it("seeds 'starred' count from prefetched entries.count with starredOnly input", () => {
    const { result } = setupTracked((qc) => {
      qc.setQueryData(entriesCountKey({ starredOnly: true }), { total: 10, unread: 5 });
    });

    const starredCount = result.collections.counts.get("starred");
    expect(starredCount).toBeDefined();
    expect(starredCount?.total).toBe(10);
    expect(starredCount?.unread).toBe(5);
  });

  it("seeds 'saved' count from prefetched entries.count with type=saved input", () => {
    const { result } = setupTracked((qc) => {
      qc.setQueryData(entriesCountKey({ type: "saved" }), { total: 20, unread: 10 });
    });

    const savedCount = result.collections.counts.get("saved");
    expect(savedCount).toBeDefined();
    expect(savedCount?.total).toBe(20);
    expect(savedCount?.unread).toBe(10);
  });

  it("seeds multiple count categories from prefetched data", () => {
    const { result } = setupTracked((qc) => {
      qc.setQueryData(entriesCountKey({}), { total: 100, unread: 50 });
      qc.setQueryData(entriesCountKey({ starredOnly: true }), { total: 10, unread: 5 });
      qc.setQueryData(entriesCountKey({ type: "saved" }), { total: 20, unread: 10 });
    });

    expect(result.collections.counts.get("all")?.total).toBe(100);
    expect(result.collections.counts.get("starred")?.total).toBe(10);
    expect(result.collections.counts.get("saved")?.total).toBe(20);
  });

  it("ignores entries.count queries with unrecognized input (e.g. subscriptionId filter)", () => {
    const { result } = setupTracked((qc) => {
      // This has a subscriptionId filter, which doesn't map to all/starred/saved
      qc.setQueryData(entriesCountKey({ subscriptionId: "sub-1" }), { total: 30, unread: 15 });
    });

    expect(result.collections.counts.has("all")).toBe(false);
    expect(result.collections.counts.has("starred")).toBe(false);
    expect(result.collections.counts.has("saved")).toBe(false);
  });

  it("does not seed any counts when no entries.count data is prefetched", () => {
    const { result } = setupTracked();

    expect(result.collections.counts.has("all")).toBe(false);
    expect(result.collections.counts.has("starred")).toBe(false);
    expect(result.collections.counts.has("saved")).toBe(false);
  });
});

// ============================================================================
// Query Cache Subscription - Async Count Updates
// ============================================================================

describe("query cache subscription: entries.count updates", () => {
  it("syncs 'all' count when entries.count query succeeds after initialization", async () => {
    const { queryClient, result } = setupTracked();

    // Simulate a query resolving after createCollections was called
    // by setting query data and triggering the cache subscription
    queryClient.setQueryData(entriesCountKey({}), { total: 200, unread: 80 });

    // The cache subscription fires synchronously in setQueryData
    const allCount = result.collections.counts.get("all");
    expect(allCount).toBeDefined();
    expect(allCount?.total).toBe(200);
    expect(allCount?.unread).toBe(80);
  });

  it("syncs 'starred' count when entries.count query succeeds after initialization", () => {
    const { queryClient, result } = setupTracked();

    queryClient.setQueryData(entriesCountKey({ starredOnly: true }), { total: 15, unread: 8 });

    const starredCount = result.collections.counts.get("starred");
    expect(starredCount).toBeDefined();
    expect(starredCount?.total).toBe(15);
    expect(starredCount?.unread).toBe(8);
  });

  it("syncs 'saved' count when entries.count query succeeds after initialization", () => {
    const { queryClient, result } = setupTracked();

    queryClient.setQueryData(entriesCountKey({ type: "saved" }), { total: 25, unread: 12 });

    const savedCount = result.collections.counts.get("saved");
    expect(savedCount).toBeDefined();
    expect(savedCount?.total).toBe(25);
    expect(savedCount?.unread).toBe(12);
  });

  it("updates existing count when new data arrives", () => {
    const { queryClient, result } = setupTracked((qc) => {
      qc.setQueryData(entriesCountKey({}), { total: 100, unread: 50 });
    });

    expect(result.collections.counts.get("all")?.total).toBe(100);

    // Simulate a refetch with updated data
    queryClient.setQueryData(entriesCountKey({}), { total: 120, unread: 60 });

    expect(result.collections.counts.get("all")?.total).toBe(120);
    expect(result.collections.counts.get("all")?.unread).toBe(60);
  });

  it("ignores entries.count queries with unrecognized input", () => {
    const { queryClient, result } = setupTracked();

    queryClient.setQueryData(entriesCountKey({ subscriptionId: "sub-1" }), {
      total: 30,
      unread: 15,
    });

    // Should not have created any known count keys
    expect(result.collections.counts.has("all")).toBe(false);
    expect(result.collections.counts.has("starred")).toBe(false);
    expect(result.collections.counts.has("saved")).toBe(false);
  });
});

// ============================================================================
// Query Cache Subscription - Uncategorized Count Updates
// ============================================================================

describe("query cache subscription: uncategorized counts from tags.list", () => {
  it("syncs uncategorized counts when tags.list query succeeds after initialization", () => {
    const { queryClient, result } = setupTracked();

    queryClient.setQueryData(
      TAGS_LIST_KEY,
      mockTagsListResponse({
        uncategorized: { feedCount: 8, unreadCount: 4 },
      })
    );

    const uncategorized = result.collections.counts.get("uncategorized");
    expect(uncategorized).toBeDefined();
    expect(uncategorized?.total).toBe(8);
    expect(uncategorized?.unread).toBe(4);
  });

  it("updates existing uncategorized counts on tags.list refetch", () => {
    const { queryClient, result } = setupTracked((qc) => {
      qc.setQueryData(
        TAGS_LIST_KEY,
        mockTagsListResponse({
          uncategorized: { feedCount: 5, unreadCount: 3 },
        })
      );
    });

    expect(result.collections.counts.get("uncategorized")?.total).toBe(5);

    // Simulate refetch with updated data
    queryClient.setQueryData(
      TAGS_LIST_KEY,
      mockTagsListResponse({
        uncategorized: { feedCount: 6, unreadCount: 2 },
      })
    );

    expect(result.collections.counts.get("uncategorized")?.total).toBe(6);
    expect(result.collections.counts.get("uncategorized")?.unread).toBe(2);
  });
});

// ============================================================================
// Cleanup
// ============================================================================

describe("cleanup", () => {
  it("stops syncing counts after cleanup is called", () => {
    const { queryClient, result } = setupTracked();

    // Calling cleanup should unsubscribe from query cache
    result.cleanup();

    // Now set data -- should NOT sync to counts collection
    queryClient.setQueryData(entriesCountKey({}), { total: 999, unread: 999 });

    expect(result.collections.counts.has("all")).toBe(false);
  });
});

// ============================================================================
// Collections structure
// ============================================================================

describe("createCollections structure", () => {
  it("creates all expected collection types", () => {
    const { result } = setupTracked();

    expect(result.collections.subscriptions).toBeDefined();
    expect(result.collections.tags).toBeDefined();
    expect(result.collections.entries).toBeDefined();
    expect(result.collections.counts).toBeDefined();
    expect(result.collections.activeViewCollection).toBeNull();
    expect(typeof result.collections.invalidateActiveView).toBe("function");
  });

  it("returns a cleanup function", () => {
    const { result } = setupTracked();
    expect(typeof result.cleanup).toBe("function");
  });

  it("invalidateActiveView is a no-op by default", () => {
    const { result } = setupTracked();
    // Should not throw
    result.collections.invalidateActiveView();
  });
});

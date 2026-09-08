/**
 * Tests for findParentListPlaceholderData — the cache read behind
 * EntryListFallback, which paints a list view from a cached parent list while
 * the real query loads.
 *
 * The load-bearing cases here are the *rejections*: neither of the predicates
 * it uses (`filtersEqual`, `areFiltersCompatible`) looks at `query` or
 * `sortBy`, so a cached search or Recently Read list otherwise reads as a
 * perfectly good parent and its rows get painted as "All Items". Membership in
 * a search can't be evaluated client-side, and Recently Read is ordered by a
 * field the placeholder path can't re-sort by.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import {
  findParentListPlaceholderData,
  type EntryListFilters,
  type EntryListItem,
} from "@/lib/cache/entry-cache";
import { _resetSubscriptionLookupMap } from "@/lib/cache/count-cache";

// ============================================================================
// Helpers
// ============================================================================

let queryClient: QueryClient;

beforeEach(() => {
  _resetSubscriptionLookupMap();
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

function makeRow(id: string, overrides: Partial<EntryListItem> = {}): EntryListItem {
  return {
    id,
    feedId: "feed-1",
    subscriptionId: "sub-1",
    type: "web",
    url: `https://example.com/${id}`,
    title: id,
    author: null,
    summary: null,
    publishedAt: new Date("2024-06-01T00:00:00Z"),
    fetchedAt: new Date("2024-06-01T00:00:00Z"),
    updatedAt: new Date("2024-06-01T00:00:00Z"),
    read: false,
    starred: false,
    feedTitle: "Feed One",
    siteName: null,
    ...overrides,
  };
}

/** Seeds an entries.list infinite query cache the way tRPC keys it. */
function seedList(
  filters: EntryListFilters,
  pages: Array<{ items: EntryListItem[]; nextCursor?: string }>
): void {
  queryClient.setQueryData([["entries", "list"], { input: filters, type: "infinite" }], {
    pages,
    pageParams: pages.map((_, i) => (i === 0 ? undefined : `cursor-${i}`)),
  });
}

/** The flattened placeholder rows for `filters`, or undefined if none was offered. */
function placeholderIds(filters: EntryListFilters): string[] | undefined {
  const result = findParentListPlaceholderData(queryClient, filters);
  return result?.pages.flatMap((page) => page.items.map((item) => item.id));
}

// ============================================================================
// Rejections: caches whose membership/order can't be reproduced client-side
// ============================================================================

describe("findParentListPlaceholderData - unusable caches", () => {
  it("does not treat a search cache as an exact match for the same view without a search", () => {
    // Reload on /all?q=react, then clear the search. The un-searched key is
    // uncached, so the fallback renders — and must not paint the handful of
    // search hits as the whole unread list.
    seedList({ query: "react", unreadOnly: true, sortOrder: "newest" }, [
      { items: [makeRow("hit-1"), makeRow("hit-2")] },
    ]);

    expect(placeholderIds({ unreadOnly: true, sortOrder: "newest" })).toBeUndefined();
  });

  it("does not use a search cache as a compatible parent list", () => {
    // A search over everything (unreadOnly=false) is a filter-superset of the
    // unread-only list by every field the compatibility check looks at.
    seedList({ query: "react", unreadOnly: false }, [
      { items: [makeRow("hit-1"), makeRow("hit-2", { read: true })] },
    ]);

    expect(placeholderIds({ unreadOnly: true })).toBeUndefined();
  });

  it("does not use a search cache for a subscription page", () => {
    seedList({ query: "react" }, [{ items: [makeRow("hit-1", { subscriptionId: "sub-1" })] }]);

    expect(placeholderIds({ subscriptionId: "sub-1" })).toBeUndefined();
  });

  it("does not use the Recently Read cache, which is ordered by read time", () => {
    seedList({ sortBy: "readChanged", unreadOnly: false }, [
      { items: [makeRow("recent-1", { read: true }), makeRow("recent-2", { read: true })] },
    ]);

    expect(placeholderIds({ unreadOnly: false })).toBeUndefined();
  });

  it("prefers a real list over a search cache seeded before it", () => {
    seedList({ query: "react", unreadOnly: true }, [{ items: [makeRow("hit-1")] }]);
    seedList({ unreadOnly: true }, [{ items: [makeRow("all-1"), makeRow("all-2")] }]);

    expect(placeholderIds({ unreadOnly: true })).toEqual(["all-1", "all-2"]);
  });
});

// ============================================================================
// Ordinary placeholder selection still works
// ============================================================================

describe("findParentListPlaceholderData - usable caches", () => {
  it("returns the cached pages verbatim on an exact filter match", () => {
    seedList({ unreadOnly: true, sortOrder: "newest" }, [
      { items: [makeRow("a"), makeRow("b")], nextCursor: "cursor-1" },
      { items: [makeRow("c")] },
    ]);

    const result = findParentListPlaceholderData(queryClient, {
      unreadOnly: true,
      sortOrder: "newest",
    });

    // Both pages survive, cursors included — an exact hit needs no re-filtering.
    expect(result?.pages.map((page) => page.items.map((item) => item.id))).toEqual([
      ["a", "b"],
      ["c"],
    ]);
    expect(result?.pages[0].nextCursor).toBe("cursor-1");
  });

  it("filters the All list down to a subscription page", () => {
    seedList({ unreadOnly: true }, [
      {
        items: [
          makeRow("mine-1", { subscriptionId: "sub-1" }),
          makeRow("theirs", { subscriptionId: "sub-2" }),
          makeRow("mine-2", { subscriptionId: "sub-1" }),
        ],
      },
    ]);

    expect(placeholderIds({ subscriptionId: "sub-1", unreadOnly: true })).toEqual([
      "mine-1",
      "mine-2",
    ]);
  });

  it("drops read entries when the unread-only list borrows an all-entries cache", () => {
    seedList({ unreadOnly: false }, [
      { items: [makeRow("unread-1"), makeRow("read-1", { read: true })] },
    ]);

    expect(placeholderIds({ unreadOnly: true })).toEqual(["unread-1"]);
  });

  it("still accepts a cache that sorts by published date", () => {
    // The guard rejects a non-default sortBy, not the presence of the key.
    seedList({ sortBy: "published", unreadOnly: true }, [{ items: [makeRow("a")] }]);

    expect(placeholderIds({ unreadOnly: true })).toEqual(["a"]);
  });
});

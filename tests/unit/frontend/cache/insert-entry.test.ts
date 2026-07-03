/**
 * Tests for insertEntryIntoListCaches.
 *
 * Verifies that new entries are inserted into exactly the cached entries.list
 * queries they belong to, in sorted position, without disturbing pagination:
 * filter targeting (subscription/tag/uncategorized/starred/type), sort-order
 * handling (newest/oldest, beyond-the-window skips), dedupe idempotency, and
 * skipping caches whose ordering can't be reproduced client-side (search,
 * Recently Read).
 */

import { describe, it, expect, beforeEach } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import {
  insertEntryIntoListCaches,
  type EntryListItem,
  type AffectedScope,
  type EntryListFilters,
} from "@/lib/cache/entry-cache";

// ============================================================================
// Helpers
// ============================================================================

let queryClient: QueryClient;

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

function makeEntry(overrides: Partial<EntryListItem> = {}): EntryListItem {
  return {
    id: "entry-new",
    feedId: "feed-1",
    subscriptionId: "sub-1",
    type: "web",
    url: "https://example.com/new",
    title: "New Entry",
    author: "Author",
    summary: "Summary",
    publishedAt: new Date("2024-07-01T00:00:00Z"),
    fetchedAt: new Date("2024-07-01T00:00:00Z"),
    updatedAt: new Date("2024-07-01T00:00:00Z"),
    read: false,
    starred: false,
    feedTitle: "Feed One",
    siteName: null,
    ...overrides,
  };
}

/** A minimal cached list row; only id + sort fields matter for insertion. */
function makeRow(id: string, publishedAt: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    read: false,
    starred: false,
    subscriptionId: "sub-1",
    type: "web",
    publishedAt: new Date(publishedAt),
    fetchedAt: new Date(publishedAt),
    ...overrides,
  };
}

interface SeededPage {
  items: Array<Record<string, unknown>>;
  nextCursor?: string;
}

/** Seeds an entries.list infinite query cache the way tRPC keys it. */
function seedList(filters: EntryListFilters & { query?: string }, pages: SeededPage[]): void {
  queryClient.setQueryData([["entries", "list"], { input: filters, type: "infinite" }], {
    pages,
    pageParams: pages.map((_, i) => (i === 0 ? undefined : `cursor-${i}`)),
  });
}

/** Reads back the flattened item IDs for a seeded list. */
function listIds(filters: EntryListFilters & { query?: string }): string[] {
  const data = queryClient.getQueryData<{ pages: SeededPage[] }>([
    ["entries", "list"],
    { input: filters, type: "infinite" },
  ]);
  return data?.pages.flatMap((page) => page.items.map((item) => item.id as string)) ?? [];
}

const NO_SCOPE: AffectedScope = { tagIds: new Set(), hasUncategorized: false };

// Rows newest-first, like a real "newest" list from the server
const NEWEST_ROWS = [
  makeRow("entry-c", "2024-06-03T00:00:00Z"),
  makeRow("entry-b", "2024-06-02T00:00:00Z"),
  makeRow("entry-a", "2024-06-01T00:00:00Z"),
];

// ============================================================================
// Sorted insertion
// ============================================================================

describe("insertEntryIntoListCaches - sorted insertion", () => {
  it("inserts a newest entry at the top of a newest-sorted list", () => {
    seedList({}, [{ items: NEWEST_ROWS }]);

    insertEntryIntoListCaches(queryClient, makeEntry(), NO_SCOPE);

    expect(listIds({})).toEqual(["entry-new", "entry-c", "entry-b", "entry-a"]);
  });

  it("inserts an older entry in sorted position (feed backfill)", () => {
    seedList({}, [{ items: NEWEST_ROWS }]);

    insertEntryIntoListCaches(
      queryClient,
      makeEntry({
        publishedAt: new Date("2024-06-01T12:00:00Z"),
        fetchedAt: new Date("2024-07-01T00:00:00Z"),
      }),
      NO_SCOPE
    );

    expect(listIds({})).toEqual(["entry-c", "entry-b", "entry-new", "entry-a"]);
  });

  it("sorts by fetchedAt when publishedAt is null", () => {
    seedList({}, [{ items: NEWEST_ROWS }]);

    insertEntryIntoListCaches(
      queryClient,
      makeEntry({ publishedAt: null, fetchedAt: new Date("2024-07-01T00:00:00Z") }),
      NO_SCOPE
    );

    expect(listIds({})).toEqual(["entry-new", "entry-c", "entry-b", "entry-a"]);
  });

  it("inserts into the correct page of a multi-page list", () => {
    seedList({}, [
      { items: [makeRow("entry-c", "2024-06-03T00:00:00Z")], nextCursor: "c1" },
      { items: [makeRow("entry-a", "2024-06-01T00:00:00Z")] },
    ]);

    insertEntryIntoListCaches(
      queryClient,
      makeEntry({
        publishedAt: new Date("2024-06-02T00:00:00Z"),
        fetchedAt: new Date("2024-06-02T00:00:00Z"),
      }),
      NO_SCOPE
    );

    const data = queryClient.getQueryData<{ pages: SeededPage[] }>([
      ["entries", "list"],
      { input: {}, type: "infinite" },
    ]);
    // Lands at the start of the second page; page cursors untouched
    expect(data?.pages[0].items.map((i) => i.id)).toEqual(["entry-c"]);
    expect(data?.pages[0].nextCursor).toBe("c1");
    expect(data?.pages[1].items.map((i) => i.id)).toEqual(["entry-new", "entry-a"]);
  });

  it("skips an entry that sorts beyond a partially-loaded window", () => {
    // Older than everything loaded, and there are more pages — the entry
    // belongs to an unfetched page, so inserting here would misplace it.
    seedList({}, [{ items: NEWEST_ROWS, nextCursor: "c1" }]);

    insertEntryIntoListCaches(
      queryClient,
      makeEntry({
        publishedAt: new Date("2024-05-01T00:00:00Z"),
        fetchedAt: new Date("2024-05-01T00:00:00Z"),
      }),
      NO_SCOPE
    );

    expect(listIds({})).toEqual(["entry-c", "entry-b", "entry-a"]);
  });

  it("appends an entry that sorts last when the list is fully loaded", () => {
    seedList({}, [{ items: NEWEST_ROWS }]);

    insertEntryIntoListCaches(
      queryClient,
      makeEntry({
        publishedAt: new Date("2024-05-01T00:00:00Z"),
        fetchedAt: new Date("2024-05-01T00:00:00Z"),
      }),
      NO_SCOPE
    );

    expect(listIds({})).toEqual(["entry-c", "entry-b", "entry-a", "entry-new"]);
  });

  it("inserts into an empty, fully-loaded list", () => {
    seedList({}, [{ items: [] }]);

    insertEntryIntoListCaches(queryClient, makeEntry(), NO_SCOPE);

    expect(listIds({})).toEqual(["entry-new"]);
  });

  it("appends to the end of an oldest-sorted list when fully loaded", () => {
    seedList({ sortOrder: "oldest" }, [
      {
        items: [
          makeRow("entry-a", "2024-06-01T00:00:00Z"),
          makeRow("entry-b", "2024-06-02T00:00:00Z"),
        ],
      },
    ]);

    insertEntryIntoListCaches(queryClient, makeEntry(), NO_SCOPE);

    expect(listIds({ sortOrder: "oldest" })).toEqual(["entry-a", "entry-b", "entry-new"]);
  });

  it("skips an oldest-sorted list that has unloaded pages", () => {
    seedList({ sortOrder: "oldest" }, [
      { items: [makeRow("entry-a", "2024-06-01T00:00:00Z")], nextCursor: "c1" },
    ]);

    insertEntryIntoListCaches(queryClient, makeEntry(), NO_SCOPE);

    expect(listIds({ sortOrder: "oldest" })).toEqual(["entry-a"]);
  });

  it("is idempotent: inserting the same entry twice keeps one copy", () => {
    // SSE and a reconnect catch-up sync can deliver the same new_entry event
    seedList({}, [{ items: NEWEST_ROWS }]);

    insertEntryIntoListCaches(queryClient, makeEntry(), NO_SCOPE);
    insertEntryIntoListCaches(queryClient, makeEntry(), NO_SCOPE);

    expect(listIds({})).toEqual(["entry-new", "entry-c", "entry-b", "entry-a"]);
  });
});

// ============================================================================
// Filter targeting
// ============================================================================

describe("insertEntryIntoListCaches - filter targeting", () => {
  it("inserts into the matching subscription list and skips other subscriptions", () => {
    seedList({ subscriptionId: "sub-1" }, [
      { items: [makeRow("entry-a", "2024-06-01T00:00:00Z")] },
    ]);
    seedList({ subscriptionId: "sub-2" }, [
      { items: [makeRow("entry-x", "2024-06-01T00:00:00Z")] },
    ]);

    insertEntryIntoListCaches(queryClient, makeEntry({ subscriptionId: "sub-1" }), NO_SCOPE);

    expect(listIds({ subscriptionId: "sub-1" })).toEqual(["entry-new", "entry-a"]);
    expect(listIds({ subscriptionId: "sub-2" })).toEqual(["entry-x"]);
  });

  it("inserts into tag lists only when the tag is in the affected scope", () => {
    seedList({ tagId: "tag-1" }, [{ items: [makeRow("entry-a", "2024-06-01T00:00:00Z")] }]);
    seedList({ tagId: "tag-2" }, [{ items: [makeRow("entry-x", "2024-06-01T00:00:00Z")] }]);

    insertEntryIntoListCaches(queryClient, makeEntry(), {
      tagIds: new Set(["tag-1"]),
      hasUncategorized: false,
    });

    expect(listIds({ tagId: "tag-1" })).toEqual(["entry-new", "entry-a"]);
    expect(listIds({ tagId: "tag-2" })).toEqual(["entry-x"]);
  });

  it("inserts into the uncategorized list only when scope says uncategorized", () => {
    seedList({ uncategorized: true }, [{ items: [makeRow("entry-a", "2024-06-01T00:00:00Z")] }]);

    insertEntryIntoListCaches(queryClient, makeEntry(), NO_SCOPE);
    expect(listIds({ uncategorized: true })).toEqual(["entry-a"]);

    insertEntryIntoListCaches(queryClient, makeEntry(), {
      tagIds: new Set(),
      hasUncategorized: true,
    });
    expect(listIds({ uncategorized: true })).toEqual(["entry-new", "entry-a"]);
  });

  it("skips starredOnly lists (new entries are never starred)", () => {
    seedList({ starredOnly: true }, [{ items: [makeRow("entry-a", "2024-06-01T00:00:00Z")] }]);

    insertEntryIntoListCaches(queryClient, makeEntry(), NO_SCOPE);

    expect(listIds({ starredOnly: true })).toEqual(["entry-a"]);
  });

  it("inserts into unreadOnly lists (new entries are always unread)", () => {
    seedList({ unreadOnly: true }, [{ items: [makeRow("entry-a", "2024-06-01T00:00:00Z")] }]);

    insertEntryIntoListCaches(queryClient, makeEntry(), NO_SCOPE);

    expect(listIds({ unreadOnly: true })).toEqual(["entry-new", "entry-a"]);
  });

  it("respects the type filter (saved entry goes to the saved list, web does not)", () => {
    seedList({ type: "saved" }, [{ items: [makeRow("entry-a", "2024-06-01T00:00:00Z")] }]);

    insertEntryIntoListCaches(queryClient, makeEntry({ type: "web" }), NO_SCOPE);
    expect(listIds({ type: "saved" })).toEqual(["entry-a"]);

    insertEntryIntoListCaches(
      queryClient,
      makeEntry({ id: "entry-saved-new", type: "saved", subscriptionId: null }),
      NO_SCOPE
    );
    expect(listIds({ type: "saved" })).toEqual(["entry-saved-new", "entry-a"]);
  });

  it("inserts a saved entry (null subscriptionId) into the All list", () => {
    seedList({}, [{ items: [makeRow("entry-a", "2024-06-01T00:00:00Z")] }]);

    insertEntryIntoListCaches(
      queryClient,
      makeEntry({ type: "saved", subscriptionId: null }),
      NO_SCOPE
    );

    expect(listIds({})).toEqual(["entry-new", "entry-a"]);
  });

  it("skips search-result and Recently Read lists", () => {
    seedList({ query: "search terms" }, [{ items: [makeRow("entry-a", "2024-06-01T00:00:00Z")] }]);
    seedList({ sortBy: "readChanged" }, [{ items: [makeRow("entry-b", "2024-06-01T00:00:00Z")] }]);

    insertEntryIntoListCaches(queryClient, makeEntry(), NO_SCOPE);

    expect(listIds({ query: "search terms" })).toEqual(["entry-a"]);
    expect(listIds({ sortBy: "readChanged" })).toEqual(["entry-b"]);
  });
});

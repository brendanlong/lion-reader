/**
 * Unit tests for Google Reader wire-format helpers.
 */

import { describe, it, expect } from "vitest";
import {
  formatEntryAsItem,
  formatTagList,
  formatUnreadCounts,
} from "../../src/server/google-reader/format";
import { buildGreaderLabels } from "../../src/server/google-reader/labels";
import { labelStreamId, stateStreamId } from "../../src/server/google-reader/streams";
import type { EntryFull } from "../../src/server/services/entries";

// Feed stream serials, as Postgres hands them back (int8 → decimal string).
const SUB_A = "42";
const SAVED_FEED = "1007";

// Distinct, fixed newest-item times so timestamp assertions are deterministic.
const NEWEST_A = new Date("2026-03-01T12:00:00.000Z");
const NEWEST_SAVED = new Date("2026-04-15T08:30:00.000Z"); // later than NEWEST_A

describe("formatUnreadCounts", () => {
  it("emits a line per subscription with unread items, and the All count as the total", () => {
    // The lines sum to 5, but one article is in both feeds' lines (a feed and
    // a collection holding it), so All — the reading-list total — is 4.
    const result = formatUnreadCounts(
      [
        { streamId: SUB_A, unreadCount: 3 },
        { streamId: SAVED_FEED, unreadCount: 2 },
      ],
      new Map([
        [SUB_A, NEWEST_A],
        [SAVED_FEED, NEWEST_SAVED],
      ]),
      4,
      []
    );

    const byId = new Map(result.unreadcounts.map((c) => [c.id, c.count]));
    expect(byId.get(`feed/${SUB_A}`)).toBe(3);
    expect(byId.get(`feed/${SAVED_FEED}`)).toBe(2);
    expect(byId.get(stateStreamId("reading-list"))).toBe(4);
  });

  it("omits subscriptions with zero unread and the total when nothing is unread", () => {
    const result = formatUnreadCounts([{ streamId: SUB_A, unreadCount: 0 }], new Map(), 0, []);
    expect(result.unreadcounts).toEqual([]);
  });

  it("reports the total with a current timestamp when no feed line has unread items", () => {
    // Starred articles of unsubscribed feeds count toward All but no feed line.
    const before = Date.now();
    const result = formatUnreadCounts([], new Map(), 2, []);
    const [total] = result.unreadcounts;
    expect(total.id).toBe(stateStreamId("reading-list"));
    expect(total.count).toBe(2);
    expect(Number(total.newestItemTimestampUsec)).toBeGreaterThanOrEqual(before * 1000);
  });

  it("reports each feed's newest visible item time, and the max across feeds for the total", () => {
    const result = formatUnreadCounts(
      [
        { streamId: SUB_A, unreadCount: 3 },
        { streamId: SAVED_FEED, unreadCount: 2 },
      ],
      new Map([
        [SUB_A, NEWEST_A],
        [SAVED_FEED, NEWEST_SAVED],
      ]),
      5,
      []
    );

    const usecById = new Map(result.unreadcounts.map((c) => [c.id, c.newestItemTimestampUsec]));
    // microseconds = ms * 1000, exact (not "now"). Regression: the synthetic
    // saved feed once derived this from an epoch `subscribedAt`, emitting a
    // literal "0" that made clients treat it as never-updated.
    expect(usecById.get(`feed/${SUB_A}`)).toBe((NEWEST_A.getTime() * 1000).toString());
    expect(usecById.get(`feed/${SAVED_FEED}`)).toBe((NEWEST_SAVED.getTime() * 1000).toString());
    // reading-list total carries the newest across all feeds.
    expect(usecById.get(stateStreamId("reading-list"))).toBe(
      (NEWEST_SAVED.getTime() * 1000).toString()
    );
  });

  it("emits a line per label with unread items, at its newest item time", () => {
    const result = formatUnreadCounts([], new Map(), 3, [
      { name: "Papers", unreadCount: 2, newestItemAt: NEWEST_A },
      { name: "Empty", unreadCount: 0, newestItemAt: undefined },
    ]);

    expect(result.unreadcounts).toContainEqual({
      id: labelStreamId("Papers"),
      count: 2,
      newestItemTimestampUsec: (NEWEST_A.getTime() * 1000).toString(),
    });
    expect(result.unreadcounts.map((c) => c.id)).not.toContain(labelStreamId("Empty"));
  });

  it("falls back to a current, non-zero timestamp when a feed is missing from the map", () => {
    // Should-not-happen (a feed with unread items always has a visible entry), but
    // the fallback must never reintroduce the "0" bug.
    const before = Date.now();
    const result = formatUnreadCounts([{ streamId: SUB_A, unreadCount: 1 }], new Map(), 1, []);
    const after = Date.now();

    const line = result.unreadcounts.find((c) => c.id === `feed/${SUB_A}`);
    expect(line).toBeDefined();
    const ms = Number(line!.newestItemTimestampUsec) / 1000;
    expect(ms).toBeGreaterThanOrEqual(before);
    expect(ms).toBeLessThanOrEqual(after);
  });
});

function makeFullEntry(overrides: Partial<EntryFull> = {}): EntryFull {
  return {
    id: "01912345-0000-7000-8000-000000000001",
    subscriptionId: "01912345-0000-7000-8000-000000000003",
    subscriptionIds: [],
    type: "web",
    url: "https://example.com/article",
    title: "An Article",
    author: null,
    contentOriginal: "<p>original teaser</p>",
    contentCleaned: "<p>cleaned teaser</p>",
    fullContent: null,
    summary: "summary",
    publishedAt: null,
    fetchedAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-02T00:00:00Z"),
    entryUpdatedAt: new Date("2026-01-02T00:00:00Z"),
    read: false,
    starred: false,
    feedTitle: null,
    feedUrl: null,
    siteName: null,
    unsubscribeUrl: null,
    ...overrides,
  };
}

// Issue #1787: clients got the feed teaser when the full article was fetched.
describe("formatEntryAsItem content", () => {
  it.each([
    ["the fetched full article", { fullContent: "<p>full</p>" }, "<p>full</p>"],
    ["the cleaned feed content", {}, "<p>cleaned teaser</p>"],
    ["the original feed content", { contentCleaned: null }, "<p>original teaser</p>"],
    ["the summary", { contentCleaned: null, contentOriginal: null }, "summary"],
  ])("serves %s when it is the best available", (_label, overrides, expected) => {
    expect(
      formatEntryAsItem(
        makeFullEntry(overrides),
        { itemId: BigInt(42), originStreamId: BigInt(7) },
        new Map()
      ).summary.content
    ).toBe(expected);
  });
});

// Issue #1821: collections are item labels.
describe("formatEntryAsItem collection labels", () => {
  it("labels an item with each collection holding it, and nothing else it's in", () => {
    const item = formatEntryAsItem(
      makeFullEntry({ subscriptionIds: ["feed-sub", "col-a", "col-b"] }),
      { itemId: BigInt(42), originStreamId: BigInt(7) },
      new Map([
        ["col-a", "Papers"],
        ["col-b", "News (collection)"],
        ["col-unrelated", "Other"],
      ])
    );

    expect(item.categories).toEqual([
      stateStreamId("reading-list"),
      labelStreamId("Papers"),
      labelStreamId("News (collection)"),
    ]);
  });
});

describe("buildGreaderLabels", () => {
  const tag = (name: string) => ({ id: `tag-${name}`, name, sortid: BigInt(1), unreadCount: 0 });
  const collection = (id: string, name: string) => ({ id, name, sortid: BigInt(2) });

  it("gives a collection that shares a tag's name, ignoring case, a distinct label", () => {
    const labels = buildGreaderLabels(
      [tag("News"), tag("news (collection)")],
      [collection("a", "NEWS"), collection("b", "Papers"), collection("c", "News (Collection 2)")]
    );

    expect(labels.collectionNames).toEqual(
      new Map([
        // "(collection)" is a tag's name and "(collection 2)" is c's own.
        ["a", "NEWS (collection 3)"],
        ["b", "Papers"],
        ["c", "News (Collection 2)"],
      ])
    );
    expect(labels.find("news")).toMatchObject({ kind: "tag", tagId: "tag-News" });
    expect(labels.find("news (COLLECTION 3)")).toMatchObject({
      kind: "collection",
      subscriptionId: "a",
    });
    expect(labels.find("papers")).toMatchObject({ kind: "collection", subscriptionId: "b" });
    expect(labels.find("missing")).toBeUndefined();
  });

  it("lists tags as folders and collections as item labels", () => {
    const labels = buildGreaderLabels([tag("News")], [collection("a", "Papers")]);

    expect(formatTagList(labels.all).slice(2)).toEqual([
      { id: labelStreamId("News"), sortid: "0000000000000001", type: "folder" },
      { id: labelStreamId("Papers"), sortid: "0000000000000002", type: "tag" },
    ]);
  });
});

import { describe, it, expect } from "vitest";
import { formatEntryFull } from "../../src/server/wallabag/format";
import type { EntryFull } from "../../src/server/services/entry-reads";

function makeFullEntry(overrides: Partial<EntryFull> = {}): EntryFull {
  return {
    id: "01912345-0000-7000-8000-000000000001",
    subscriptionId: "01912345-0000-7000-8000-000000000003",
    subscriptionIds: [],
    tagLists: { tagIds: [], uncategorized: false },
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
    readChangedAt: null,
    score: null,
    positions: {},
    feedTitle: null,
    feedUrl: null,
    siteName: null,
    unsubscribeUrl: null,
    ...overrides,
  };
}

describe("formatEntryFull", () => {
  it("counts a bare < in text as text, not the start of a tag, in linear time", () => {
    // `<[^>]*>` took ~1.5s on the tagless input (quadratic), and on the other
    // swallowed the whole run up to `<i>` as one tag.
    const readingTime = (fullContent: string) =>
      formatEntryFull(makeFullEntry({ fullContent }), 1, []).reading_time;
    const text = "a < b ".repeat(20000);
    const started = performance.now();
    const withoutTags = readingTime(`${text}c`);
    expect(performance.now() - started).toBeLessThan(200);
    expect(readingTime(`${text}<i>c</i>`)).toBe(withoutTags);
  });
});

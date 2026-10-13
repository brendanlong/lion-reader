/**
 * Unit tests for Wallabag response formatting.
 *
 * Tag ids expose a collection's stored `subscriptions.greader_stream_id`
 * serial (issue #1117); these tests pin the serial → JSON-number mapping.
 */

import { describe, it, expect } from "vitest";
import { formatEntryFull, formatSavedArticle, formatTag } from "../../src/server/wallabag/format";
import type { EntryFull } from "../../src/server/services/entries";
import type { SavedArticle } from "../../src/server/services/saved";

describe("formatSavedArticle", () => {
  it("uses the caller-supplied Wallabag id (SavedArticle carries no serial)", () => {
    const article: SavedArticle = {
      id: "01912345-0000-7000-8000-000000000002",
      url: "https://example.com/saved",
      title: "Saved",
      siteName: null,
      author: null,
      imageUrl: null,
      contentCleaned: "<p>Body</p>",
      excerpt: null,
      read: false,
      starred: true,
      savedAt: new Date("2026-01-01T00:00:00Z"),
    };

    const formatted = formatSavedArticle(article, 123, []);

    expect(formatted.id).toBe(123);
    expect(formatted.uid).toBe(article.id);
    expect(formatted.is_starred).toBe(1);
  });
});

describe("formatTag", () => {
  it("exposes the stored serial as a JSON number and slugs the label", () => {
    const formatted = formatTag({ id: BigInt(11), label: "Tech News" });

    expect(formatted).toEqual({ id: 11, label: "Tech News", slug: "tech-news" });
    expect(() => JSON.stringify(formatted)).not.toThrow();
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

describe("formatEntryFull", () => {
  // Issue #1787: clients got the feed teaser when the full article was fetched.
  it("serves the fetched full article over the feed content", () => {
    expect(formatEntryFull(makeFullEntry({ fullContent: "<p>full</p>" }), 42, []).content).toBe(
      "<p>full</p>"
    );
  });
});

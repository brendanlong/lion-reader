import { describe, it, expect } from "vitest";
import {
  BACKFILL_MIN_AGE_MS,
  clampPublishedAt,
  deriveGuid,
  generateContentHash,
  isBackfilledEntry,
} from "@/server/feed/entry-processor";
import type { ParsedEntry } from "@/server/feed/types";

describe("generateContentHash", () => {
  it("generates consistent hash for same content", () => {
    const entry: ParsedEntry = {
      title: "Test Title",
      content: "Test Content",
    };

    const hash1 = generateContentHash(entry);
    const hash2 = generateContentHash(entry);

    expect(hash1).toBe(hash2);
    expect(hash1).toMatch(/^[a-f0-9]{64}$/); // SHA-256 hex
  });

  it("generates different hash for different content", () => {
    const entry1: ParsedEntry = {
      title: "Test Title",
      content: "Content A",
    };
    const entry2: ParsedEntry = {
      title: "Test Title",
      content: "Content B",
    };

    const hash1 = generateContentHash(entry1);
    const hash2 = generateContentHash(entry2);

    expect(hash1).not.toBe(hash2);
  });

  it("handles missing content by using summary", () => {
    const entry1: ParsedEntry = {
      title: "Test Title",
      content: "Actual content",
    };
    const entry2: ParsedEntry = {
      title: "Test Title",
      summary: "Actual content",
    };

    const hash1 = generateContentHash(entry1);
    const hash2 = generateContentHash(entry2);

    // Content and summary with same text produce same hash
    expect(hash1).toBe(hash2);
  });

  it("handles empty content gracefully", () => {
    const entry: ParsedEntry = {
      title: "Only Title",
    };

    const hash = generateContentHash(entry);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("changes when the author changes but text does not", () => {
    const base: ParsedEntry = { title: "T", content: "C", author: "Alice" };
    const changed: ParsedEntry = { ...base, author: "Bob" };

    expect(generateContentHash(base)).not.toBe(generateContentHash(changed));
  });

  it("changes when the URL changes but text does not", () => {
    const base: ParsedEntry = { title: "T", content: "C", link: "https://a.com/1" };
    const changed: ParsedEntry = { ...base, link: "https://a.com/2" };

    expect(generateContentHash(base)).not.toBe(generateContentHash(changed));
  });

  it("does NOT change when only the publication date changes", () => {
    // pubDate is intentionally excluded: updateEntryContent never rewrites
    // published_at (it's the frozen denormalized timeline sort key), so hashing
    // it would only trigger updates that can't take effect.
    const base: ParsedEntry = {
      title: "T",
      content: "C",
      pubDate: new Date("2024-01-01T00:00:00Z"),
    };
    const changed: ParsedEntry = { ...base, pubDate: new Date("2024-02-01T00:00:00Z") };

    expect(generateContentHash(base)).toBe(generateContentHash(changed));
  });
});

describe("clampPublishedAt", () => {
  it("returns null when no date is provided", () => {
    expect(clampPublishedAt(undefined, new Date())).toBeNull();
  });

  it("leaves past dates untouched", () => {
    const pubDate = new Date("2024-01-15T12:00:00Z");
    const fetchedAt = new Date("2024-06-01T00:00:00Z");
    expect(clampPublishedAt(pubDate, fetchedAt)).toBe(pubDate);
  });

  it("clamps future dates down to fetchedAt", () => {
    const fetchedAt = new Date("2024-06-01T00:00:00Z");
    const pubDate = new Date("2030-01-01T00:00:00Z");
    expect(clampPublishedAt(pubDate, fetchedAt)).toBe(fetchedAt);
  });
});

describe("isBackfilledEntry", () => {
  const previousFetch = new Date("2026-08-10T00:00:00Z");

  it("flags an article published long before our previous fetch", () => {
    expect(isBackfilledEntry(new Date("2022-03-01T00:00:00Z"), previousFetch)).toBe(true);
  });

  it("does not flag an article published since our previous fetch", () => {
    expect(isBackfilledEntry(new Date("2026-08-10T00:05:00Z"), previousFetch)).toBe(false);
  });

  it("does not flag an article that is merely a few days stale", () => {
    // Stale CDN copies, clock skew and slight backdating must stay news.
    expect(isBackfilledEntry(new Date("2026-08-04T00:00:00Z"), previousFetch)).toBe(false);
  });

  it("treats exactly the threshold as news (strict comparison)", () => {
    const threshold = new Date(previousFetch.getTime() - BACKFILL_MIN_AGE_MS);
    expect(isBackfilledEntry(threshold, previousFetch)).toBe(false);
    expect(isBackfilledEntry(new Date(threshold.getTime() - 1), previousFetch)).toBe(true);
  });

  it("is inert on a feed's first fetch", () => {
    expect(isBackfilledEntry(new Date("2010-01-01T00:00:00Z"), null)).toBe(false);
    expect(isBackfilledEntry(new Date("2010-01-01T00:00:00Z"), undefined)).toBe(false);
  });

  it("is inert without a publication date", () => {
    expect(isBackfilledEntry(null, previousFetch)).toBe(false);
  });
});

describe("deriveGuid", () => {
  it("uses guid when available", () => {
    const entry: ParsedEntry = {
      guid: "unique-id-123",
      link: "https://example.com/article",
      title: "Article Title",
    };

    expect(deriveGuid(entry)).toBe("unique-id-123");
  });

  it("falls back to link when guid is missing", () => {
    const entry: ParsedEntry = {
      link: "https://example.com/article",
      title: "Article Title",
    };

    expect(deriveGuid(entry)).toBe("https://example.com/article");
  });

  it("falls back to title when guid and link are missing", () => {
    const entry: ParsedEntry = {
      title: "Article Title",
    };

    expect(deriveGuid(entry)).toBe("Article Title");
  });

  it("throws when no identifier is available", () => {
    const entry: ParsedEntry = {};

    expect(() => deriveGuid(entry)).toThrow(
      "Cannot derive GUID: entry has no guid, link, or title"
    );
  });

  it("trims whitespace from identifiers", () => {
    const entry: ParsedEntry = {
      guid: "  spaced-guid  ",
    };

    expect(deriveGuid(entry)).toBe("spaced-guid");
  });
});

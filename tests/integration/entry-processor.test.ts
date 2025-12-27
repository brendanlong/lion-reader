/**
 * Integration tests for entry processing.
 *
 * These tests use a real database to verify entry creation,
 * deduplication by GUID, and content hash change detection.
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { db } from "../../src/server/db";
import { entries, feeds } from "../../src/server/db/schema";
import { generateUuidv7 } from "../../src/lib/uuidv7";
import {
  generateContentHash,
  deriveGuid,
  generateSummary,
  findEntryByGuid,
  createEntry,
  updateEntryContent,
  processEntry,
  processEntries,
} from "../../src/server/feed/entry-processor";
import type { ParsedEntry, ParsedFeed } from "../../src/server/feed/types";

// Helper to create a test feed in the database
async function createTestFeed(overrides: Partial<typeof feeds.$inferInsert> = {}) {
  const [feed] = await db
    .insert(feeds)
    .values({
      id: generateUuidv7(),
      type: "rss",
      url: `https://example.com/feed-${Date.now()}.xml`,
      title: "Test Feed",
      ...overrides,
    })
    .returning();
  return feed;
}

describe("Entry Processor", () => {
  // Clean up tables before each test
  beforeEach(async () => {
    await db.delete(entries);
    await db.delete(feeds);
  });

  // Clean up after all tests
  afterAll(async () => {
    await db.delete(entries);
    await db.delete(feeds);
  });

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

  describe("generateSummary", () => {
    it("strips HTML tags", () => {
      const entry: ParsedEntry = {
        content: "<p>This is <strong>bold</strong> text.</p>",
      };

      expect(generateSummary(entry)).toBe("This is bold text.");
    });

    it("truncates long content to 300 characters", () => {
      const longContent = "A".repeat(500);
      const entry: ParsedEntry = {
        content: longContent,
      };

      const summary = generateSummary(entry);
      expect(summary).toHaveLength(300);
      expect(summary.endsWith("...")).toBe(true);
    });

    it("uses summary when content is missing", () => {
      const entry: ParsedEntry = {
        summary: "This is the summary.",
      };

      expect(generateSummary(entry)).toBe("This is the summary.");
    });
  });

  describe("findEntryByGuid", () => {
    it("finds existing entry by feed ID and GUID", async () => {
      const feed = await createTestFeed();
      const guid = "entry-123";

      // Create entry directly
      await db.insert(entries).values({
        id: generateUuidv7(),
        feedId: feed.id,
        guid,
        fetchedAt: new Date(),
        contentHash: "abc123",
      });

      const found = await findEntryByGuid(feed.id, guid);
      expect(found).not.toBeNull();
      expect(found?.guid).toBe(guid);
      expect(found?.feedId).toBe(feed.id);
    });

    it("returns null for non-existent entry", async () => {
      const feed = await createTestFeed();

      const found = await findEntryByGuid(feed.id, "non-existent");
      expect(found).toBeNull();
    });

    it("respects feed ID scope (same GUID, different feeds)", async () => {
      const feed1 = await createTestFeed();
      const feed2 = await createTestFeed();
      const guid = "shared-guid";

      // Create entry in feed1
      await db.insert(entries).values({
        id: generateUuidv7(),
        feedId: feed1.id,
        guid,
        fetchedAt: new Date(),
        contentHash: "abc123",
      });

      // Should find in feed1
      const found1 = await findEntryByGuid(feed1.id, guid);
      expect(found1).not.toBeNull();

      // Should not find in feed2
      const found2 = await findEntryByGuid(feed2.id, guid);
      expect(found2).toBeNull();
    });
  });

  describe("createEntry", () => {
    it("creates entry with all fields", async () => {
      const feed = await createTestFeed();
      const fetchedAt = new Date();
      const pubDate = new Date("2024-01-15T12:00:00Z");

      const parsedEntry: ParsedEntry = {
        guid: "entry-456",
        link: "https://example.com/article",
        title: "Article Title",
        author: "John Doe",
        content: "<p>Article content here.</p>",
        summary: "Article summary.",
        pubDate,
      };

      const contentHash = generateContentHash(parsedEntry);
      const entry = await createEntry(feed.id, parsedEntry, contentHash, fetchedAt);

      expect(entry.id).toBeDefined();
      expect(entry.feedId).toBe(feed.id);
      expect(entry.guid).toBe("entry-456");
      expect(entry.url).toBe("https://example.com/article");
      expect(entry.title).toBe("Article Title");
      expect(entry.author).toBe("John Doe");
      expect(entry.contentOriginal).toBe("<p>Article content here.</p>");
      expect(entry.summary).toBe("Article content here.");
      expect(entry.publishedAt?.toISOString()).toBe(pubDate.toISOString());
      expect(entry.fetchedAt.toISOString()).toBe(fetchedAt.toISOString());
      expect(entry.contentHash).toBe(contentHash);
    });

    it("derives GUID when not explicitly provided", async () => {
      const feed = await createTestFeed();

      const parsedEntry: ParsedEntry = {
        link: "https://example.com/article-no-guid",
        title: "Article Without GUID",
      };

      const entry = await createEntry(
        feed.id,
        parsedEntry,
        generateContentHash(parsedEntry),
        new Date()
      );

      // Should use link as GUID
      expect(entry.guid).toBe("https://example.com/article-no-guid");
    });
  });

  describe("updateEntryContent", () => {
    it("updates entry content and hash", async () => {
      const feed = await createTestFeed();

      // Create initial entry
      const initialEntry: ParsedEntry = {
        guid: "entry-789",
        title: "Original Title",
        content: "Original content",
      };

      const createdEntry = await createEntry(
        feed.id,
        initialEntry,
        generateContentHash(initialEntry),
        new Date()
      );

      // Update with new content
      const updatedParsedEntry: ParsedEntry = {
        guid: "entry-789",
        title: "Updated Title",
        content: "Updated content",
      };

      const newHash = generateContentHash(updatedParsedEntry);
      const updatedEntry = await updateEntryContent(createdEntry.id, updatedParsedEntry, newHash);

      expect(updatedEntry.id).toBe(createdEntry.id);
      expect(updatedEntry.title).toBe("Updated Title");
      expect(updatedEntry.contentOriginal).toBe("Updated content");
      expect(updatedEntry.contentHash).toBe(newHash);
      expect(updatedEntry.updatedAt.getTime()).toBeGreaterThan(createdEntry.createdAt.getTime());
    });
  });

  describe("processEntry", () => {
    it("creates new entry when not exists", async () => {
      const feed = await createTestFeed();

      const parsedEntry: ParsedEntry = {
        guid: "new-entry-1",
        title: "New Article",
        content: "New content",
      };

      const result = await processEntry(feed.id, parsedEntry, new Date());

      expect(result.isNew).toBe(true);
      expect(result.isUpdated).toBe(false);
      expect(result.guid).toBe("new-entry-1");
      expect(result.id).toBeDefined();

      // Verify entry exists in database
      const found = await findEntryByGuid(feed.id, "new-entry-1");
      expect(found).not.toBeNull();
    });

    it("updates entry when content hash changes", async () => {
      const feed = await createTestFeed();

      // Create initial entry
      const initialEntry: ParsedEntry = {
        guid: "entry-to-update",
        title: "Original",
        content: "Original content",
      };

      const createResult = await processEntry(feed.id, initialEntry, new Date());
      expect(createResult.isNew).toBe(true);

      // Process with different content
      const updatedEntry: ParsedEntry = {
        guid: "entry-to-update",
        title: "Updated",
        content: "New content here",
      };

      const updateResult = await processEntry(feed.id, updatedEntry, new Date());

      expect(updateResult.isNew).toBe(false);
      expect(updateResult.isUpdated).toBe(true);
      expect(updateResult.id).toBe(createResult.id); // Same entry ID

      // Verify content was updated
      const found = await findEntryByGuid(feed.id, "entry-to-update");
      expect(found?.title).toBe("Updated");
    });

    it("skips update when content hash unchanged", async () => {
      const feed = await createTestFeed();

      const entry: ParsedEntry = {
        guid: "unchanged-entry",
        title: "Same Title",
        content: "Same content",
      };

      // First process
      const result1 = await processEntry(feed.id, entry, new Date());
      expect(result1.isNew).toBe(true);

      // Second process with same content
      const result2 = await processEntry(feed.id, entry, new Date());

      expect(result2.isNew).toBe(false);
      expect(result2.isUpdated).toBe(false);
      expect(result2.id).toBe(result1.id);
    });
  });

  describe("processEntries", () => {
    it("processes all entries from a feed", async () => {
      const feed = await createTestFeed();

      const parsedFeed: ParsedFeed = {
        title: "Test Feed",
        items: [
          { guid: "entry-1", title: "Entry 1", content: "Content 1" },
          { guid: "entry-2", title: "Entry 2", content: "Content 2" },
          { guid: "entry-3", title: "Entry 3", content: "Content 3" },
        ],
      };

      const result = await processEntries(feed.id, parsedFeed);

      expect(result.newCount).toBe(3);
      expect(result.updatedCount).toBe(0);
      expect(result.unchangedCount).toBe(0);
      expect(result.entries).toHaveLength(3);

      // Verify all entries are new
      for (const entry of result.entries) {
        expect(entry.isNew).toBe(true);
        expect(entry.isUpdated).toBe(false);
      }
    });

    it("counts new, updated, and unchanged correctly", async () => {
      const feed = await createTestFeed();

      // First fetch: 3 new entries
      const firstFeed: ParsedFeed = {
        title: "Test Feed",
        items: [
          { guid: "entry-a", title: "Entry A", content: "Content A" },
          { guid: "entry-b", title: "Entry B", content: "Content B" },
          { guid: "entry-c", title: "Entry C", content: "Content C" },
        ],
      };

      await processEntries(feed.id, firstFeed);

      // Second fetch: 1 unchanged, 1 updated, 1 new
      const secondFeed: ParsedFeed = {
        title: "Test Feed",
        items: [
          { guid: "entry-a", title: "Entry A", content: "Content A" }, // unchanged
          { guid: "entry-b", title: "Entry B Updated", content: "New B content" }, // updated
          { guid: "entry-d", title: "Entry D", content: "Content D" }, // new
        ],
      };

      const result = await processEntries(feed.id, secondFeed);

      expect(result.newCount).toBe(1);
      expect(result.updatedCount).toBe(1);
      expect(result.unchangedCount).toBe(1);
    });

    it("uses provided fetchedAt timestamp", async () => {
      const feed = await createTestFeed();
      const customFetchedAt = new Date("2024-06-15T10:00:00Z");

      const parsedFeed: ParsedFeed = {
        title: "Test Feed",
        items: [{ guid: "timestamped-entry", title: "Entry", content: "Content" }],
      };

      await processEntries(feed.id, parsedFeed, { fetchedAt: customFetchedAt });

      const entry = await findEntryByGuid(feed.id, "timestamped-entry");
      expect(entry?.fetchedAt.toISOString()).toBe(customFetchedAt.toISOString());
    });

    it("continues processing after invalid entry", async () => {
      const feed = await createTestFeed();

      const parsedFeed: ParsedFeed = {
        title: "Test Feed",
        items: [
          { guid: "valid-1", title: "Valid Entry 1", content: "Content" },
          {}, // Invalid - no GUID, link, or title
          { guid: "valid-2", title: "Valid Entry 2", content: "Content" },
        ],
      };

      const result = await processEntries(feed.id, parsedFeed);

      // Should process the valid entries
      expect(result.newCount).toBe(2);
      expect(result.entries).toHaveLength(2);
    });

    it("handles empty feed", async () => {
      const feed = await createTestFeed();

      const parsedFeed: ParsedFeed = {
        title: "Empty Feed",
        items: [],
      };

      const result = await processEntries(feed.id, parsedFeed);

      expect(result.newCount).toBe(0);
      expect(result.updatedCount).toBe(0);
      expect(result.unchangedCount).toBe(0);
      expect(result.entries).toHaveLength(0);
    });

    it("prevents duplicate entries (deduplication by GUID)", async () => {
      const feed = await createTestFeed();

      // Process same entry twice in same batch
      const parsedFeed: ParsedFeed = {
        title: "Test Feed",
        items: [
          { guid: "duplicate", title: "First", content: "Content" },
          { guid: "duplicate", title: "Second", content: "Different content" },
        ],
      };

      // First entry creates, second updates (since content differs)
      const result = await processEntries(feed.id, parsedFeed);

      expect(result.newCount).toBe(1);
      expect(result.updatedCount).toBe(1);

      // Both should reference the same entry ID
      expect(result.entries[0].id).toBe(result.entries[1].id);
    });
  });
});

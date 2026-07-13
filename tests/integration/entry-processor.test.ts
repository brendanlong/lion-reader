/**
 * Integration tests for entry processing.
 *
 * These tests use a real database to verify entry creation,
 * deduplication by GUID, and content hash change detection.
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../../src/server/db";
import { entries, feeds, subscriptions, userEntries, users } from "../../src/server/db/schema";
import { createPubSubSubscription, getFeedEventsChannel } from "../../src/server/redis/pubsub";
import { generateUuidv7 } from "../../src/lib/uuidv7";
import {
  generateContentHash,
  clampPublishedAt,
  deriveGuid,
  generateEntrySummary,
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
      type: "web",
      url: `https://example.com/feed-${generateUuidv7()}.xml`,
      title: "Test Feed",
      ...overrides,
    })
    .returning();
  return feed;
}

describe("Entry Processor", () => {
  // Clean up tables before each test
  beforeEach(async () => {
    await db.delete(userEntries);
    await db.delete(entries);
    await db.delete(subscriptions);
    await db.delete(feeds);
    await db.delete(users);
  });

  // Clean up after all tests
  afterAll(async () => {
    await db.delete(userEntries);
    await db.delete(entries);
    await db.delete(subscriptions);
    await db.delete(feeds);
    await db.delete(users);
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

  describe("generateEntrySummary", () => {
    it("strips HTML tags", () => {
      const entry: ParsedEntry = {
        content: "<p>This is <strong>bold</strong> text.</p>",
      };

      expect(generateEntrySummary(entry)).toBe("This is bold text.");
    });

    it("removes style tags and their content", () => {
      const entry: ParsedEntry = {
        content: "<style>#content img { max-width: 100% }</style><p>Actual content here.</p>",
      };

      expect(generateEntrySummary(entry)).toBe("Actual content here.");
    });

    it("removes script tags and their content", () => {
      const entry: ParsedEntry = {
        content:
          '<script>alert("bad")</script><p>Visible text.</p><script type="text/javascript">more code</script>',
      };

      expect(generateEntrySummary(entry)).toBe("Visible text.");
    });

    it("truncates long content to 300 characters", () => {
      const longContent = "A".repeat(500);
      const entry: ParsedEntry = {
        content: longContent,
      };

      const summary = generateEntrySummary(entry);
      expect(summary).toHaveLength(300);
      expect(summary.endsWith("...")).toBe(true);
    });

    it("uses summary when content is missing", () => {
      const entry: ParsedEntry = {
        summary: "This is the summary.",
      };

      expect(generateEntrySummary(entry)).toBe("This is the summary.");
    });
  });

  describe("findEntryByGuid", () => {
    it("finds existing entry by feed ID and GUID", async () => {
      const feed = await createTestFeed();
      const guid = "entry-123";

      // Create entry directly
      const now = new Date();
      await db.insert(entries).values({
        id: generateUuidv7(),
        feedId: feed.id,
        type: "web",
        guid,
        fetchedAt: now,
        lastSeenAt: now,
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
      const now = new Date();
      await db.insert(entries).values({
        id: generateUuidv7(),
        feedId: feed1.id,
        type: "web",
        guid,
        fetchedAt: now,
        lastSeenAt: now,
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
      const entry = await createEntry(feed.id, "web", parsedEntry, contentHash, fetchedAt);

      expect(entry.id).toBeDefined();
      expect(entry.feedId).toBe(feed.id);
      expect(entry.guid).toBe("entry-456");
      expect(entry.url).toBe("https://example.com/article");
      expect(entry.title).toBe("Article Title");
      expect(entry.author).toBe("John Doe");
      expect(entry.contentOriginal).toBe("<p>Article content here.</p>");
      // Summary prefers feed-provided summary over generating from content
      expect(entry.summary).toBe("Article summary.");
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
        "web",
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
        "web",
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
      expect(updatedEntry.updatedAt.getTime()).toBeGreaterThanOrEqual(
        createdEntry.createdAt.getTime()
      );
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

      const result = await processEntry(feed.id, "web", parsedEntry, new Date());

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

      const createResult = await processEntry(feed.id, "web", initialEntry, new Date());
      expect(createResult.isNew).toBe(true);

      // Process with different content
      const updatedEntry: ParsedEntry = {
        guid: "entry-to-update",
        title: "Updated",
        content: "New content here",
      };

      const updateResult = await processEntry(feed.id, "web", updatedEntry, new Date());

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
      const result1 = await processEntry(feed.id, "web", entry, new Date());
      expect(result1.isNew).toBe(true);

      // Second process with same content
      const result2 = await processEntry(feed.id, "web", entry, new Date());

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

      const result = await processEntries(feed.id, feed.type, parsedFeed);

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

      await processEntries(feed.id, feed.type, firstFeed);

      // Second fetch: 1 unchanged, 1 updated, 1 new
      const secondFeed: ParsedFeed = {
        title: "Test Feed",
        items: [
          { guid: "entry-a", title: "Entry A", content: "Content A" }, // unchanged
          { guid: "entry-b", title: "Entry B Updated", content: "New B content" }, // updated
          { guid: "entry-d", title: "Entry D", content: "Content D" }, // new
        ],
      };

      const result = await processEntries(feed.id, feed.type, secondFeed);

      expect(result.newCount).toBe(1);
      expect(result.updatedCount).toBe(1);
      expect(result.unchangedCount).toBe(1);
    });

    it("bumps last_seen_at without touching updated_at for unchanged entries (#1084)", async () => {
      const feed = await createTestFeed();

      // First fetch: 2 entries become current.
      const firstFetchedAt = new Date("2024-06-15T10:00:00Z");
      await processEntries(
        feed.id,
        feed.type,
        {
          title: "Test Feed",
          items: [
            { guid: "entry-a", title: "Entry A", content: "Content A" },
            { guid: "entry-b", title: "Entry B", content: "Content B" },
          ],
        },
        { fetchedAt: firstFetchedAt }
      );

      const beforeA = await findEntryByGuid(feed.id, "entry-a");
      const beforeB = await findEntryByGuid(feed.id, "entry-b");
      expect(beforeA?.lastSeenAt?.toISOString()).toBe(firstFetchedAt.toISOString());

      // Second fetch: entry A is unchanged, a new entry C appears. This is a
      // "hasChanges" fetch, so lastSeenAt is refreshed for all still-present
      // entries — but updated_at must NOT move for the unchanged entry A, or
      // every subscriber's delta sync would re-ship it as a content change.
      const secondFetchedAt = new Date("2024-06-15T11:00:00Z");
      await processEntries(
        feed.id,
        feed.type,
        {
          title: "Test Feed",
          items: [
            { guid: "entry-a", title: "Entry A", content: "Content A" }, // unchanged
            { guid: "entry-c", title: "Entry C", content: "Content C" }, // new
          ],
        },
        {
          fetchedAt: secondFetchedAt,
          previousLastEntriesUpdatedAt: firstFetchedAt,
        }
      );

      const afterA = await findEntryByGuid(feed.id, "entry-a");
      // last_seen_at advanced (A is still present in the feed)...
      expect(afterA?.lastSeenAt?.toISOString()).toBe(secondFetchedAt.toISOString());
      // ...but updated_at did not (A's content never changed).
      expect(afterA?.updatedAt.toISOString()).toBe(beforeA?.updatedAt.toISOString());
      // Entry B disappeared from the feed; its last_seen_at stays put.
      const afterB = await findEntryByGuid(feed.id, "entry-b");
      expect(afterB?.lastSeenAt?.toISOString()).toBe(beforeB?.lastSeenAt?.toISOString());
    });

    it("alwaysUpdateVisibility re-stamps last_seen_at and fans out on an unchanged fetch", async () => {
      // The subscribe-time forced refresh sets alwaysUpdateVisibility so that an
      // unchanged fetch still re-stamps every current entry to one generation and
      // fans out user_entries — the visibility bookkeeping a normal unchanged
      // poll deliberately skips (#1084). This is what lets a brand-new subscriber
      // see ground truth (issue #1078).
      const feed = await createTestFeed({ url: `https://example.com/aiv-${generateUuidv7()}.xml` });

      const firstFetchedAt = new Date("2024-06-15T10:00:00Z");
      const items = [
        { guid: "aiv-a", title: "Entry A", content: "Content A" },
        { guid: "aiv-b", title: "Entry B", content: "Content B" },
      ];
      await processEntries(
        feed.id,
        feed.type,
        { title: "T", items },
        { fetchedAt: firstFetchedAt }
      );

      // A subscriber that joins AFTER the first fetch has no user_entries yet.
      const userId = generateUuidv7();
      await db.insert(users).values({
        id: userId,
        email: `aiv-${userId}@test.com`,
        passwordHash: "test-hash",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      await db.insert(subscriptions).values({
        id: generateUuidv7(),
        userId,
        feedId: feed.id,
        subscribedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      // Re-fetch the identical feed (nothing changed) with alwaysUpdateVisibility.
      const secondFetchedAt = new Date("2024-06-15T11:00:00Z");
      const result = await processEntries(
        feed.id,
        feed.type,
        { title: "T", items },
        { fetchedAt: secondFetchedAt, alwaysUpdateVisibility: true }
      );

      // Nothing actually changed...
      expect(result.hasChanges).toBe(false);
      // ...but last_seen_at was re-stamped to this fetch for the current entries.
      const afterA = await findEntryByGuid(feed.id, "aiv-a");
      const afterB = await findEntryByGuid(feed.id, "aiv-b");
      expect(afterA?.lastSeenAt?.toISOString()).toBe(secondFetchedAt.toISOString());
      expect(afterB?.lastSeenAt?.toISOString()).toBe(secondFetchedAt.toISOString());

      // ...and the late subscriber was fanned out despite no changes.
      const rows = await db
        .select({ entryId: userEntries.entryId })
        .from(userEntries)
        .where(eq(userEntries.userId, userId));
      expect(rows).toHaveLength(2);
    });

    it("alwaysUpdateVisibility leaves a pushed-then-deleted entry below the new generation (#1078 privacy)", async () => {
      // A WebSub feed pushed entry C (stamped above the poll generation). The
      // publisher then removed C. A forced subscribe-time refresh (the current
      // feed no longer lists C) must re-stamp the entries that ARE present to a
      // new generation and leave C behind, so the `>=` subscribe populate — run
      // with the refreshed last_entries_updated_at — excludes the removed entry.
      const feed = await createTestFeed({ url: `https://example.com/del-${generateUuidv7()}.xml` });

      const pollTime = new Date("2024-06-15T10:00:00Z");
      await processEntries(
        feed.id,
        feed.type,
        {
          title: "T",
          items: [
            { guid: "del-a", title: "A", content: "A" },
            { guid: "del-b", title: "B", content: "B" },
          ],
        },
        { fetchedAt: pollTime }
      );

      // Entry C arrives by a hub push after the poll (stamped above pollTime).
      const pushTime = new Date("2024-06-15T10:30:00Z");
      await processEntries(
        feed.id,
        feed.type,
        { title: "T", items: [{ guid: "del-c", title: "C", content: "C" }] },
        { fetchedAt: pushTime }
      );
      const cBefore = await findEntryByGuid(feed.id, "del-c");
      expect(cBefore?.lastSeenAt?.toISOString()).toBe(pushTime.toISOString());

      // Forced subscribe-time refresh: the current feed no longer lists C.
      const refreshTime = new Date("2024-06-15T11:00:00Z");
      await processEntries(
        feed.id,
        feed.type,
        {
          title: "T",
          items: [
            { guid: "del-a", title: "A", content: "A" },
            { guid: "del-b", title: "B", content: "B" },
          ],
        },
        {
          fetchedAt: refreshTime,
          previousLastEntriesUpdatedAt: pollTime,
          alwaysUpdateVisibility: true,
        }
      );

      // A and B advance to the new generation; the removed C stays behind, so
      // C.last_seen_at (pushTime) < the new generation (refreshTime) and `>=`
      // with last_entries_updated_at = refreshTime would exclude it.
      const aAfter = await findEntryByGuid(feed.id, "del-a");
      const cAfter = await findEntryByGuid(feed.id, "del-c");
      expect(aAfter?.lastSeenAt?.toISOString()).toBe(refreshTime.toISOString());
      expect(cAfter?.lastSeenAt?.toISOString()).toBe(pushTime.toISOString());
      expect(cAfter!.lastSeenAt!.getTime()).toBeLessThan(refreshTime.getTime());
    });

    it("does NOT fan out or re-stamp on an unchanged fetch without alwaysUpdateVisibility", async () => {
      // Guards the #1084 optimization: a normal unchanged poll must leave
      // last_seen_at alone and skip the fanout.
      const feed = await createTestFeed({
        url: `https://example.com/noaiv-${generateUuidv7()}.xml`,
      });
      const firstFetchedAt = new Date("2024-06-15T10:00:00Z");
      const items = [{ guid: "noaiv-a", title: "Entry A", content: "Content A" }];
      await processEntries(
        feed.id,
        feed.type,
        { title: "T", items },
        { fetchedAt: firstFetchedAt }
      );

      const userId = generateUuidv7();
      await db.insert(users).values({
        id: userId,
        email: `noaiv-${userId}@test.com`,
        passwordHash: "test-hash",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      await db.insert(subscriptions).values({
        id: generateUuidv7(),
        userId,
        feedId: feed.id,
        subscribedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const secondFetchedAt = new Date("2024-06-15T11:00:00Z");
      await processEntries(
        feed.id,
        feed.type,
        { title: "T", items },
        { fetchedAt: secondFetchedAt }
      );

      const afterA = await findEntryByGuid(feed.id, "noaiv-a");
      expect(afterA?.lastSeenAt?.toISOString()).toBe(firstFetchedAt.toISOString());
      const rows = await db
        .select({ entryId: userEntries.entryId })
        .from(userEntries)
        .where(eq(userEntries.userId, userId));
      expect(rows).toHaveLength(0);
    });

    it("detects a pushed-then-removed entry as disappeared via `>=` (#1078)", async () => {
      // A hub-pushed entry sits above last_entries_updated_at (last_seen_at =
      // pushTime). When a later poll no longer lists it, disappeared detection
      // must catch it (it used strict equality on the poll generation and missed
      // push-stamped entries), so the poll registers hasChanges and the caller
      // advances the generation past the stranded entry.
      const feed = await createTestFeed({ url: `https://example.com/gte-${generateUuidv7()}.xml` });

      const pollTime = new Date("2024-06-15T10:00:00Z");
      await processEntries(
        feed.id,
        feed.type,
        { title: "T", items: [{ guid: "gte-a", title: "A", content: "A" }] },
        { fetchedAt: pollTime }
      );

      // Delta push of C, stamped above the poll generation.
      const pushTime = new Date("2024-06-15T10:30:00Z");
      await processEntries(
        feed.id,
        feed.type,
        { title: "T", items: [{ guid: "gte-c", title: "C", content: "C" }] },
        { fetchedAt: pushTime }
      );

      // Next poll: C is gone. Detection keys off previousLastEntriesUpdatedAt =
      // pollTime; C is stamped at pushTime > pollTime, so only `>=` catches it.
      const laterPoll = new Date("2024-06-15T11:00:00Z");
      const result = await processEntries(
        feed.id,
        feed.type,
        { title: "T", items: [{ guid: "gte-a", title: "A", content: "A" }] },
        { fetchedAt: laterPoll, previousLastEntriesUpdatedAt: pollTime }
      );

      expect(result.disappearedCount).toBe(1);
      expect(result.hasChanges).toBe(true);
    });

    it("writes last_seen_at monotonically (never regresses under a lower timestamp)", async () => {
      // The subscribe-time inline refresh bypasses the job queue's per-feed
      // serialization, so a lower-timestamped writer must not drag a stamp back
      // below the feed's (forward-only) last_entries_updated_at — that would make
      // the `>=` populate match nothing (#1078). Simulate an already-advanced
      // stamp and an unchanged re-process at an earlier timestamp.
      const feed = await createTestFeed({
        url: `https://example.com/mono-${generateUuidv7()}.xml`,
      });

      const laterTime = new Date("2024-06-15T12:00:00Z");
      await processEntries(
        feed.id,
        feed.type,
        { title: "T", items: [{ guid: "mono-a", title: "A", content: "A" }] },
        { fetchedAt: laterTime }
      );
      expect((await findEntryByGuid(feed.id, "mono-a"))?.lastSeenAt?.toISOString()).toBe(
        laterTime.toISOString()
      );

      // Re-process the same (unchanged) entry at an EARLIER timestamp with
      // alwaysUpdateVisibility — the monotonic guard must keep the later stamp.
      const earlierTime = new Date("2024-06-15T10:00:00Z");
      await processEntries(
        feed.id,
        feed.type,
        { title: "T", items: [{ guid: "mono-a", title: "A", content: "A" }] },
        { fetchedAt: earlierTime, alwaysUpdateVisibility: true }
      );
      expect((await findEntryByGuid(feed.id, "mono-a"))?.lastSeenAt?.toISOString()).toBe(
        laterTime.toISOString()
      );
    });

    it("uses provided fetchedAt timestamp", async () => {
      const feed = await createTestFeed();
      const customFetchedAt = new Date("2024-06-15T10:00:00Z");

      const parsedFeed: ParsedFeed = {
        title: "Test Feed",
        items: [{ guid: "timestamped-entry", title: "Entry", content: "Content" }],
      };

      await processEntries(feed.id, feed.type, parsedFeed, { fetchedAt: customFetchedAt });

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

      const result = await processEntries(feed.id, feed.type, parsedFeed);

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

      const result = await processEntries(feed.id, feed.type, parsedFeed);

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
      const result = await processEntries(feed.id, feed.type, parsedFeed);

      expect(result.newCount).toBe(1);
      expect(result.updatedCount).toBe(1);

      // Both should reference the same entry ID
      expect(result.entries[0].id).toBe(result.entries[1].id);
    });

    it("publishes new_entry only after the user_entries fanout", async () => {
      // Regression test: the SSE endpoint computes each subscriber's absolute
      // unread counts from visible_entries the moment a new_entry event
      // arrives. If the event were published before createUserEntriesForFeed
      // (as it used to be), those counts would exclude the new entries and
      // unread badges would stay stale. Assert that by the time each
      // new_entry message is delivered, the subscriber's user_entries row
      // already exists.
      const feed = await createTestFeed();

      const userId = generateUuidv7();
      await db.insert(users).values({
        id: userId,
        email: `fanout-${userId}@test.com`,
        passwordHash: "test-hash",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      await db.insert(subscriptions).values({
        id: generateUuidv7(),
        userId,
        feedId: feed.id,
        subscribedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      // On each delivered new_entry, immediately check (at arrival time)
      // whether the subscriber's user_entries row exists.
      const rowExistedAtDelivery: Array<Promise<boolean>> = [];
      const handle = createPubSubSubscription((_channel, message) => {
        const event = JSON.parse(message) as { type: string; entryId: string };
        if (event.type !== "new_entry") return;
        rowExistedAtDelivery.push(
          db
            .select({ entryId: userEntries.entryId })
            .from(userEntries)
            .where(and(eq(userEntries.userId, userId), eq(userEntries.entryId, event.entryId)))
            .then((rows) => rows.length === 1)
        );
      });
      expect(handle).not.toBeNull();
      await handle!.subscribe(getFeedEventsChannel(feed.id));

      try {
        const parsedFeed: ParsedFeed = {
          title: "Test Feed",
          items: [
            { guid: "fanout-1", title: "Entry 1", content: "Content 1" },
            { guid: "fanout-2", title: "Entry 2", content: "Content 2" },
          ],
        };
        await processEntries(feed.id, feed.type, parsedFeed);

        // Publishes are fire-and-forget, so wait for delivery.
        const deadline = Date.now() + 5000;
        while (rowExistedAtDelivery.length < 2 && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(rowExistedAtDelivery).toHaveLength(2);
        expect(await Promise.all(rowExistedAtDelivery)).toEqual([true, true]);
      } finally {
        handle!.close();
      }
    });

    it("heals entries orphaned by an earlier crashed fetch (#952)", async () => {
      // Regression test for the non-atomic fanout: if a fetch inserts an entry
      // but the worker crashes before createUserEntriesForFeed, the entry exists
      // with a matching content_hash. The old event-driven fanout only ran for
      // isNew entries, so on the retry the orphan was isNew:false and never
      // became visible. The state-driven fanout passes every current entry ID,
      // so any later fetch with activity heals it.
      const feed = await createTestFeed();

      const userId = generateUuidv7();
      await db.insert(users).values({
        id: userId,
        email: `heal-${userId}@test.com`,
        passwordHash: "test-hash",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      await db.insert(subscriptions).values({
        id: generateUuidv7(),
        userId,
        feedId: feed.id,
        subscribedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      // Simulate the crash: insert the entry directly (as a fetch would) but
      // never fan out user_entries.
      const orphanParsed: ParsedEntry = {
        guid: "orphan-1",
        title: "Orphan",
        content: "Orphan content",
      };
      const orphan = await createEntry(
        feed.id,
        "web",
        orphanParsed,
        generateContentHash(orphanParsed),
        new Date()
      );

      const before = await db.select().from(userEntries).where(eq(userEntries.userId, userId));
      expect(before).toHaveLength(0);

      // Next fetch: the orphan is unchanged, but a genuinely new entry arrives,
      // so the feed has activity and the fanout runs over all current entries.
      const parsedFeed: ParsedFeed = {
        title: "Test Feed",
        items: [orphanParsed, { guid: "new-1", title: "New", content: "New content" }],
      };
      const result = await processEntries(feed.id, feed.type, parsedFeed);
      expect(result.newCount).toBe(1); // only new-1 counts as new

      const after = await db
        .select({ entryId: userEntries.entryId })
        .from(userEntries)
        .where(eq(userEntries.userId, userId));
      const ids = after.map((r) => r.entryId);
      // The previously-orphaned entry is now visible, alongside the new one.
      expect(ids).toContain(orphan.id);
      expect(ids).toHaveLength(2);
    });
  });
});

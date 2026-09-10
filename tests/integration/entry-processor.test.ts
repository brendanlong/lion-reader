/**
 * Integration tests for entry processing.
 *
 * These tests use a real database to verify entry creation,
 * deduplication by GUID, and content hash change detection.
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../../src/server/db";
import { entries, feeds, subscriptions, userEntries, users } from "../../src/server/db/schema";
import { createPubSubSubscription, getFeedEventsChannel } from "../../src/server/redis/pubsub";
import { generateUuidv7 } from "../../src/lib/uuidv7";
import {
  generateContentHash,
  clampPublishedAt,
  deriveGuid,
  createEntry,
  updateEntryContent,
  processEntries,
  isBackfilledEntry,
} from "../../src/server/feed/entry-processor";
import { canonicalGuid, canonicalGuidSql } from "../../src/server/feed/guid-identity";
import type { ParsedEntry, ParsedFeed } from "../../src/server/feed/types";
import {
  createTestSubscription,
  createTestUser,
  createTestFeed as insertTestFeed,
} from "./helpers";

async function findEntryByGuid(feedId: string, guid: string) {
  const [entry] = await db
    .select()
    .from(entries)
    .where(and(eq(entries.feedId, feedId), eq(entries.guid, guid)))
    .limit(1);

  return entry ?? null;
}

// Wraps the shared factory because these call sites want the feed row
// (feed.url, feed.type), not just its id.
async function createTestFeed(overrides: Partial<typeof feeds.$inferInsert> = {}) {
  const feedId = await insertTestFeed({ title: "Test Feed", ...overrides });
  const [feed] = await db.select().from(feeds).where(eq(feeds.id, feedId));
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
      const exactly30Days = new Date(previousFetch.getTime() - 30 * 24 * 60 * 60 * 1000);
      expect(isBackfilledEntry(exactly30Days, previousFetch)).toBe(false);
      expect(isBackfilledEntry(new Date(exactly30Days.getTime() - 1), previousFetch)).toBe(true);
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

  describe("processEntries per-entry results", () => {
    it("creates new entry when not exists", async () => {
      const feed = await createTestFeed();

      const parsedEntry: ParsedEntry = {
        guid: "new-entry-1",
        title: "New Article",
        content: "New content",
      };

      const { entries: results } = await processEntries(feed.id, feed.type, {
        title: "Test Feed",
        items: [parsedEntry],
      });

      expect(results).toHaveLength(1);
      expect(results[0].isNew).toBe(true);
      expect(results[0].isUpdated).toBe(false);
      expect(results[0].guid).toBe("new-entry-1");
      expect(results[0].id).toBeDefined();

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

      const createResult = await processEntries(feed.id, feed.type, {
        title: "Test Feed",
        items: [initialEntry],
      });
      expect(createResult.entries[0].isNew).toBe(true);

      // Process with different content
      const updatedEntry: ParsedEntry = {
        guid: "entry-to-update",
        title: "Updated",
        content: "New content here",
      };

      const updateResult = await processEntries(feed.id, feed.type, {
        title: "Test Feed",
        items: [updatedEntry],
      });

      expect(updateResult.entries[0].isNew).toBe(false);
      expect(updateResult.entries[0].isUpdated).toBe(true);
      expect(updateResult.entries[0].id).toBe(createResult.entries[0].id); // Same entry ID

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
      const result1 = await processEntries(feed.id, feed.type, {
        title: "Test Feed",
        items: [entry],
      });
      expect(result1.entries[0].isNew).toBe(true);

      // Second process with same content
      const result2 = await processEntries(feed.id, feed.type, {
        title: "Test Feed",
        items: [entry],
      });

      expect(result2.entries[0].isNew).toBe(false);
      expect(result2.entries[0].isUpdated).toBe(false);
      expect(result2.entries[0].id).toBe(result1.entries[0].id);
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
      const userId = await createTestUser({ emailPrefix: "aiv" });
      await createTestSubscription(userId, feed.id);

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

      const userId = await createTestUser({ emailPrefix: "noaiv" });
      await createTestSubscription(userId, feed.id);

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

    describe("scheme-insensitive guid matching (#1535)", () => {
      // WordPress.com serves `http://site/?p=N` guids in the polled feed while
      // its WebSub hub pushes the `https://` spelling, so the same post arrives
      // under two guids. They must resolve to one entry.
      it("updates an existing entry in place when only the guid scheme changed", async () => {
        const feed = await createTestFeed();

        const first = await processEntries(feed.id, feed.type, {
          title: "T",
          items: [{ guid: "http://example.com/?p=1", title: "Post", content: "v1" }],
        });
        expect(first.newCount).toBe(1);

        const second = await processEntries(feed.id, feed.type, {
          title: "T",
          items: [{ guid: "https://example.com/?p=1", title: "Post", content: "v2 (edited)" }],
        });
        expect(second.newCount).toBe(0);
        expect(second.updatedCount).toBe(1);
        expect(second.entries[0].id).toBe(first.entries[0].id);

        // The stored guid keeps its original spelling.
        const rows = await db.select().from(entries).where(eq(entries.feedId, feed.id));
        expect(rows).toHaveLength(1);
        expect(rows[0].guid).toBe("http://example.com/?p=1");
        expect(rows[0].contentOriginal).toContain("v2 (edited)");
      });

      it("collapses two items in one document whose guids differ only by scheme", async () => {
        const feed = await createTestFeed();

        const link = "https://example.com/2024/06/post/";
        const result = await processEntries(feed.id, feed.type, {
          title: "T",
          items: [
            { guid: "http://example.com/?p=1", link, title: "Post", content: "A" },
            { guid: "https://example.com/?p=1", link, title: "Post", content: "A" },
          ],
        });
        expect(result.newCount).toBe(1);
        expect(result.unchangedCount).toBe(1);
        expect(result.entries[0].id).toBe(result.entries[1].id);
      });

      it("does not report a scheme flip as a disappeared entry or a change", async () => {
        // The permalink stays put (as on WordPress, where only the guid flips);
        // without a link the guid doubles as the entry URL and a flip is a
        // genuine URL change.
        const feed = await createTestFeed();
        const link = "https://example.com/2024/06/post/";
        const pollTime = new Date("2024-06-15T10:00:00Z");
        await processEntries(
          feed.id,
          feed.type,
          {
            title: "T",
            items: [{ guid: "http://example.com/?p=1", link, title: "P", content: "A" }],
          },
          { fetchedAt: pollTime }
        );

        const result = await processEntries(
          feed.id,
          feed.type,
          {
            title: "T",
            items: [{ guid: "https://example.com/?p=1", link, title: "P", content: "A" }],
          },
          { fetchedAt: new Date("2024-06-15T11:00:00Z"), previousLastEntriesUpdatedAt: pollTime }
        );
        expect(result.disappearedCount).toBe(0);
        expect(result.hasChanges).toBe(false);
      });

      it("computes the same key in SQL as in TypeScript", async () => {
        const guids = [
          "http://example.com/?p=1",
          "https://example.com/?p=1",
          "HTTP://example.com/?p=1",
          "example.com/?p=1",
          "tag:x,2026:http://example.com/a",
          "http://example.com/a\nhttp://example.com/b",
        ];
        const values = sql.join(
          guids.map((g) => sql`(${g})`),
          sql`, `
        );
        const rows = await db.execute<{ guid: string; key: string }>(sql`
          SELECT g AS guid, ${sql.raw(canonicalGuidSql("g"))} AS key
          FROM (VALUES ${values}) AS t(g)
        `);
        expect(rows.rows).toHaveLength(guids.length);
        for (const row of rows.rows) {
          expect(row.key).toBe(canonicalGuid(row.guid));
        }
      });

      it("treats a scheme flip of both guid and link as unchanged", async () => {
        // WordPress.com is documented to flip the scheme of <link> as well as
        // <guid> between fetches; that must not register as an update on every
        // poll. Same for an entry whose URL is its guid (no <link>).
        const feed = await createTestFeed();
        await processEntries(feed.id, feed.type, {
          title: "T",
          items: [
            {
              guid: "http://example.com/?p=1",
              link: "http://example.com/2024/06/post/",
              title: "P",
              content: "A",
            },
            { guid: "http://example.com/?p=2", title: "Q", content: "B" },
          ],
        });

        const result = await processEntries(feed.id, feed.type, {
          title: "T",
          items: [
            {
              guid: "https://example.com/?p=1",
              link: "https://example.com/2024/06/post/",
              title: "P",
              content: "A",
            },
            { guid: "https://example.com/?p=2", title: "Q", content: "B" },
          ],
        });
        expect(result.newCount).toBe(0);
        expect(result.updatedCount).toBe(0);
        expect(result.unchangedCount).toBe(2);
        expect(result.hasChanges).toBe(false);

        const rows = await db.select().from(entries).where(eq(entries.feedId, feed.id));
        expect(rows.map((r) => r.url).sort()).toEqual([
          "http://example.com/2024/06/post/",
          "http://example.com/?p=2",
        ]);
      });

      it("keeps guids that differ beyond the scheme distinct", async () => {
        const feed = await createTestFeed();

        const result = await processEntries(feed.id, feed.type, {
          title: "T",
          items: [
            { guid: "http://example.com/?p=1", title: "A", content: "A" },
            { guid: "example.com/?p=1", title: "B", content: "B" },
            { guid: "http://other.example.com/?p=1", title: "C", content: "C" },
            { guid: "http://example.com/?p=1/", title: "D", content: "D" },
            { guid: "HTTP://example.com/?p=1", title: "E", content: "E" },
          ],
        });
        expect(result.newCount).toBe(5);
      });

      it("resolves pre-existing scheme twins to the oldest row on every fetch", async () => {
        // Rows duplicated before this matching existed: both spellings are
        // stored. Every later fetch must update the same (oldest) row, whichever
        // spelling arrives, so the newer twin quietly ages out.
        const feed = await createTestFeed();
        const makeParsed = (guid: string): ParsedEntry => ({ guid, title: "Post", content: "A" });
        const older = await createEntry(
          feed.id,
          "web",
          makeParsed("http://example.com/?p=1"),
          generateContentHash(makeParsed("http://example.com/?p=1")),
          new Date()
        );
        // UUIDv7 ids only order across milliseconds; real twins are minutes apart.
        await new Promise((resolve) => setTimeout(resolve, 5));
        const newer = await createEntry(
          feed.id,
          "web",
          makeParsed("https://example.com/?p=1"),
          generateContentHash(makeParsed("https://example.com/?p=1")),
          new Date()
        );
        expect(older.id < newer.id).toBe(true);

        for (const guid of ["https://example.com/?p=1", "http://example.com/?p=1"]) {
          const result = await processEntries(feed.id, feed.type, {
            title: "T",
            items: [{ guid, title: "Post", content: "edited" }],
          });
          expect(result.newCount).toBe(0);
          expect(result.entries[0].id).toBe(older.id);
        }
      });

      it("skips the fanout for an entry a previous feed already delivered under the other scheme", async () => {
        // Redirect dedupe: after a feed merge, entries attributed to this
        // subscription under the old feed_id suppress re-delivery of the same
        // guid from the new feed. A move to https usually re-spells the guids
        // too, so the comparison has to be scheme-insensitive.
        const oldFeed = await createTestFeed();
        const newFeed = await createTestFeed();
        const userId = await createTestUser({ emailPrefix: "redirect" });
        const subscriptionId = await createTestSubscription(userId, newFeed.id);

        const oldParsed: ParsedEntry = {
          guid: "http://example.com/?p=1",
          title: "P",
          content: "A",
        };
        const oldEntry = await createEntry(
          oldFeed.id,
          "web",
          oldParsed,
          generateContentHash(oldParsed),
          new Date()
        );
        await db.insert(userEntries).values({
          userId,
          entryId: oldEntry.id,
          subscriptionId,
          read: true,
        });

        const result = await processEntries(newFeed.id, newFeed.type, {
          title: "T",
          items: [
            { guid: "https://example.com/?p=1", title: "P", content: "A" },
            { guid: "https://example.com/?p=2", title: "Q", content: "B" },
          ],
        });
        expect(result.newCount).toBe(2);

        const rows = await db
          .select({ entryId: userEntries.entryId })
          .from(userEntries)
          .where(eq(userEntries.userId, userId));
        const ids = rows.map((r) => r.entryId);
        expect(ids).toContain(oldEntry.id);
        expect(ids).toContain(result.entries[1].id);
        expect(ids).not.toContain(result.entries[0].id);
      });
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

      const userId = await createTestUser({ emailPrefix: "fanout" });
      await createTestSubscription(userId, feed.id);

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

    it("fans out an archive re-announcement as read, not unread (#1500)", async () => {
      // A publisher that bulk-edits its archive re-announces posts we have never
      // seen, dated years ago. They are stored and made visible, but they are not
      // news, so they must not land in anyone's unread count.
      const feed = await createTestFeed();
      const userId = await createTestUser({ emailPrefix: "backfill" });
      const subscriptionId = await createTestSubscription(userId, feed.id);

      const previousLastFetchedAt = new Date("2026-08-10T00:00:00Z");
      const fetchedAt = new Date("2026-08-10T01:00:00Z");
      const parsedFeed: ParsedFeed = {
        title: "Test Feed",
        items: [
          { guid: "fresh-1", title: "Today's post", pubDate: new Date("2026-08-10T00:30:00Z") },
          {
            guid: "archive-1",
            title: "Ukraine Post #5",
            pubDate: new Date("2022-03-01T00:00:00Z"),
          },
        ],
      };

      const result = await processEntries(feed.id, feed.type, parsedFeed, {
        fetchedAt,
        previousLastFetchedAt,
      });

      expect(result.newCount).toBe(2);
      expect(result.backfillCount).toBe(1);

      const rows = await db
        .select({
          guid: entries.guid,
          read: userEntries.read,
          readChangedAt: userEntries.readChangedAt,
          isBackfill: entries.isBackfill,
        })
        .from(userEntries)
        .innerJoin(entries, eq(entries.id, userEntries.entryId))
        .where(eq(userEntries.userId, userId));
      expect(rows).toHaveLength(2);
      expect(rows.find((r) => r.guid === "fresh-1")?.read).toBe(false);
      expect(rows.find((r) => r.guid === "archive-1")?.read).toBe(true);
      // The verdict is persisted on the entry, so every later path that grants
      // visibility reads the same fact instead of re-deriving it.
      expect(rows.find((r) => r.guid === "archive-1")?.isBackfill).toBe(true);
      expect(rows.find((r) => r.guid === "fresh-1")?.isBackfill).toBe(false);
      // Left NULL so a later explicit mark-unread by the user wins the
      // last-writer-wins comparison in markEntriesRead.
      expect(rows.find((r) => r.guid === "archive-1")?.readChangedAt).toBeNull();

      // The unread badge only counts the genuinely new article.
      const [subscription] = await db
        .select({ unreadCount: subscriptions.unreadCount })
        .from(subscriptions)
        .where(eq(subscriptions.id, subscriptionId));
      expect(subscription.unreadCount).toBe(1);
    });

    it("keeps old entries unread on a feed's first fetch (#1500)", async () => {
      // Without a previous fetch we were never watching the feed, so its whole
      // current window is legitimately new to us however old it is.
      const feed = await createTestFeed();
      const userId = await createTestUser({ emailPrefix: "firstfetch" });
      await createTestSubscription(userId, feed.id);

      const result = await processEntries(
        feed.id,
        feed.type,
        {
          title: "Test Feed",
          items: [{ guid: "old-1", title: "Old", pubDate: new Date("2022-03-01T00:00:00Z") }],
        },
        { fetchedAt: new Date("2026-08-10T01:00:00Z"), previousLastFetchedAt: null }
      );

      expect(result.backfillCount).toBe(0);
      const [row] = await db
        .select({ read: userEntries.read })
        .from(userEntries)
        .where(eq(userEntries.userId, userId));
      expect(row.read).toBe(false);
    });

    it("keeps a backfill read when the same document repeats its GUID (#1500)", async () => {
      // deriveGuid falls back to link and then to title, so two archive posts
      // sharing a title collapse onto one entry: the second occurrence resolves
      // to the already-created row and reports isNew/isBackfill false. Reading
      // the read state off entries.is_backfill rather than off which list the id
      // landed in is what keeps that from fanning the row out unread.
      const feed = await createTestFeed();
      const userId = await createTestUser({ emailPrefix: "dupguid" });
      await createTestSubscription(userId, feed.id);

      const item = { title: "Ukraine Post #5", pubDate: new Date("2022-03-01T00:00:00Z") };
      const result = await processEntries(
        feed.id,
        feed.type,
        { title: "Test Feed", items: [item, item] },
        {
          fetchedAt: new Date("2026-08-10T01:00:00Z"),
          previousLastFetchedAt: new Date("2026-08-10T00:00:00Z"),
        }
      );
      expect(result.newCount).toBe(1);
      expect(result.backfillCount).toBe(1);

      const rows = await db
        .select({ read: userEntries.read })
        .from(userEntries)
        .where(eq(userEntries.userId, userId));
      expect(rows).toHaveLength(1);
      expect(rows[0].read).toBe(true);
    });

    it("heals a backfill orphaned by a crashed fetch to read, not unread (#1500)", async () => {
      // The #952 self-heal re-covers entries a crashed fetch never fanned out.
      // It reports them isNew:false and has no memory of how they were
      // classified, so the read state has to come from entries.is_backfill.
      const feed = await createTestFeed();
      const userId = await createTestUser({ emailPrefix: "healbackfill" });
      await createTestSubscription(userId, feed.id);

      const archived: ParsedEntry = {
        guid: "archive-1",
        title: "Ukraine Post #5",
        pubDate: new Date("2022-03-01T00:00:00Z"),
      };
      // Simulate the crash: the entry row exists, the user_entries row doesn't.
      await createEntry(
        feed.id,
        "web",
        archived,
        generateContentHash(archived),
        new Date("2026-08-10T01:00:00Z"),
        undefined,
        new Date("2026-08-10T00:00:00Z")
      );
      expect(
        await db.select().from(userEntries).where(eq(userEntries.userId, userId))
      ).toHaveLength(0);

      // A later fetch brings a genuinely new entry, so the fanout runs over
      // every current entry and heals the orphan.
      await processEntries(
        feed.id,
        feed.type,
        {
          title: "Test Feed",
          items: [
            archived,
            { guid: "fresh-1", title: "New", pubDate: new Date("2026-08-10T02:00:00Z") },
          ],
        },
        {
          fetchedAt: new Date("2026-08-10T02:30:00Z"),
          previousLastFetchedAt: new Date("2026-08-10T01:00:00Z"),
        }
      );

      const rows = await db
        .select({ guid: entries.guid, read: userEntries.read })
        .from(userEntries)
        .innerJoin(entries, eq(entries.id, userEntries.entryId))
        .where(eq(userEntries.userId, userId));
      expect(rows.find((r) => r.guid === "archive-1")?.read).toBe(true);
      expect(rows.find((r) => r.guid === "fresh-1")?.read).toBe(false);
    });

    it("leaves a backfilled entry read when a later fetch re-lists it (#1500)", async () => {
      // The backfill classification only applies to entries created by that
      // fetch; the ordinary fanout that re-covers the entry later must not flip
      // it back to unread.
      const feed = await createTestFeed();
      const userId = await createTestUser({ emailPrefix: "rebackfill" });
      await createTestSubscription(userId, feed.id);

      const archived = {
        guid: "archive-1",
        title: "Ukraine Post #5",
        pubDate: new Date("2022-03-01T00:00:00Z"),
      };
      await processEntries(
        feed.id,
        feed.type,
        { title: "Test Feed", items: [archived] },
        {
          fetchedAt: new Date("2026-08-10T01:00:00Z"),
          previousLastFetchedAt: new Date("2026-08-10T00:00:00Z"),
        }
      );

      // A later fetch adds a genuinely new entry, so the fanout runs again over
      // every current entry — including the backfilled one.
      const result = await processEntries(
        feed.id,
        feed.type,
        {
          title: "Test Feed",
          items: [
            archived,
            { guid: "fresh-1", title: "New", pubDate: new Date("2026-08-10T02:00:00Z") },
          ],
        },
        {
          fetchedAt: new Date("2026-08-10T02:30:00Z"),
          previousLastFetchedAt: new Date("2026-08-10T01:00:00Z"),
        }
      );
      expect(result.newCount).toBe(1);
      expect(result.backfillCount).toBe(0);

      const rows = await db
        .select({ guid: entries.guid, read: userEntries.read })
        .from(userEntries)
        .innerJoin(entries, eq(entries.id, userEntries.entryId))
        .where(eq(userEntries.userId, userId));
      expect(rows.find((r) => r.guid === "archive-1")?.read).toBe(true);
      expect(rows.find((r) => r.guid === "fresh-1")?.read).toBe(false);
    });

    it("does not publish new_entry for a backfilled entry (#1500)", async () => {
      // A backfilled entry is fanned out as read, so there is no new unread item
      // for a connected client to insert or count.
      const feed = await createTestFeed();
      const userId = await createTestUser({ emailPrefix: "backfillevent" });
      await createTestSubscription(userId, feed.id);

      const newEntryIds: string[] = [];
      const handle = createPubSubSubscription((_channel, message) => {
        const event = JSON.parse(message) as { type: string; entryId: string };
        if (event.type === "new_entry") newEntryIds.push(event.entryId);
      });
      expect(handle).not.toBeNull();
      await handle!.subscribe(getFeedEventsChannel(feed.id));

      try {
        await processEntries(
          feed.id,
          feed.type,
          {
            title: "Test Feed",
            items: [
              { guid: "archive-1", title: "Old", pubDate: new Date("2022-03-01T00:00:00Z") },
              { guid: "fresh-1", title: "New", pubDate: new Date("2026-08-10T00:30:00Z") },
            ],
          },
          {
            fetchedAt: new Date("2026-08-10T01:00:00Z"),
            previousLastFetchedAt: new Date("2026-08-10T00:00:00Z"),
          }
        );

        // Publishes are fire-and-forget; wait long enough that a second event
        // would have arrived if one were published for the backfilled entry.
        const deadline = Date.now() + 5000;
        while (newEntryIds.length < 1 && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        await new Promise((resolve) => setTimeout(resolve, 250));

        const fresh = await findEntryByGuid(feed.id, "fresh-1");
        expect(newEntryIds).toEqual([fresh!.id]);
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

      const userId = await createTestUser({ emailPrefix: "heal" });
      await createTestSubscription(userId, feed.id);

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

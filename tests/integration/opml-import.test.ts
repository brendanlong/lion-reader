/**
 * Integration tests for OPML import functionality.
 *
 * These tests use a real database to verify OPML import operations,
 * including large imports that might trigger edge cases.
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { asc, eq } from "drizzle-orm";
import { db } from "../../src/server/db";
import {
  users,
  feeds,
  jobs,
  subscriptions,
  subscriptionTags,
  tags,
  opmlImports,
  type NewOpmlImport,
  type OpmlImportFeedData,
} from "../../src/server/db/schema";
import { generateUuidv7 } from "../../src/lib/uuidv7";
import { processOpmlImport } from "../../src/server/services/imports";
import { createCaller } from "../../src/server/trpc/root";
import {
  createAuthContext,
  createTestFeed,
  createTestSubscription,
  createTestUser,
} from "./helpers";

// ============================================================================
// Test Helpers
// ============================================================================

/**
 * Generates a simple OPML string with the specified number of feeds.
 */
function generateOpml(feedCount: number): string {
  const outlines = Array.from({ length: feedCount }, (_, i) => {
    return `    <outline type="rss" text="Feed ${i + 1}" title="Feed ${i + 1}" xmlUrl="https://example${i + 1}.com/feed.xml" htmlUrl="https://example${i + 1}.com" />`;
  }).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head>
    <title>Test OPML</title>
  </head>
  <body>
${outlines}
  </body>
</opml>`;
}

/**
 * Records a queued import the way {@link importOpml} would, so the worker-side
 * {@link processOpmlImport} can be driven directly.
 */
async function seedImport(
  userId: string,
  feedsData: OpmlImportFeedData[],
  overrides: Partial<NewOpmlImport> = {}
): Promise<string> {
  const importId = generateUuidv7();
  const now = new Date();
  await db.insert(opmlImports).values({
    id: importId,
    userId,
    status: "pending",
    totalFeeds: feedsData.length,
    importedCount: 0,
    skippedCount: 0,
    failedCount: 0,
    feedsData,
    results: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });
  return importId;
}

/** The user's active subscription URLs, in subscribe order. */
async function subscribedUrls(userId: string): Promise<(string | null)[]> {
  const rows = await db
    .select({ url: feeds.url })
    .from(subscriptions)
    .innerJoin(feeds, eq(subscriptions.feedId, feeds.id))
    .where(eq(subscriptions.userId, userId))
    .orderBy(asc(subscriptions.id));
  return rows.map((r) => r.url);
}

// ============================================================================
// Tests
// ============================================================================

describe("OPML Import", () => {
  async function cleanupTables() {
    await db.delete(opmlImports);
    await db.delete(subscriptions);
    await db.delete(jobs);
    await db.delete(feeds);
    await db.delete(users);
  }

  beforeEach(cleanupTables);
  afterAll(cleanupTables);

  describe("subscriptions.import", () => {
    it("imports a simple OPML with few feeds", async () => {
      const userId = await createTestUser();
      const ctx = await createAuthContext(userId);
      const caller = createCaller(ctx);

      const opml = generateOpml(3);

      const result = await caller.subscriptions.import({ opml });

      expect(result.totalFeeds).toBe(3);
      expect(result.importId).toBeDefined();

      // Verify import record was created
      const importRecord = await db
        .select()
        .from(opmlImports)
        .where(eq(opmlImports.id, result.importId))
        .limit(1);

      expect(importRecord).toHaveLength(1);
      expect(importRecord[0].status).toBe("pending");
      expect(importRecord[0].totalFeeds).toBe(3);
    });

    it("imports OPML with many feeds (stress test)", async () => {
      const userId = await createTestUser();
      const ctx = await createAuthContext(userId);
      const caller = createCaller(ctx);

      // Generate OPML with 500+ feeds to simulate real-world usage
      const opml = generateOpml(550);

      const result = await caller.subscriptions.import({ opml });

      expect(result.totalFeeds).toBe(550);
      expect(result.importId).toBeDefined();

      // Verify import record was created with all feed data
      const importRecord = await db
        .select()
        .from(opmlImports)
        .where(eq(opmlImports.id, result.importId))
        .limit(1);

      expect(importRecord).toHaveLength(1);
      expect(importRecord[0].status).toBe("pending");
      expect(importRecord[0].totalFeeds).toBe(550);
      expect(importRecord[0].feedsData).toHaveLength(550);
    });

    it("handles empty OPML", async () => {
      const userId = await createTestUser();
      const ctx = await createAuthContext(userId);
      const caller = createCaller(ctx);

      const opml = `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head><title>Empty</title></head>
  <body></body>
</opml>`;

      const result = await caller.subscriptions.import({ opml });

      expect(result.totalFeeds).toBe(0);
      expect(result.importId).toBeDefined();
    });

    it("rejects invalid OPML", async () => {
      const userId = await createTestUser();
      const ctx = await createAuthContext(userId);
      const caller = createCaller(ctx);

      const invalidOpml = "not valid xml at all";

      await expect(caller.subscriptions.import({ opml: invalidOpml })).rejects.toThrow(
        "Failed to parse OPML"
      );
    });

    it("handles OPML with special characters in feed titles", async () => {
      const userId = await createTestUser();
      const ctx = await createAuthContext(userId);
      const caller = createCaller(ctx);

      const opml = `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head><title>Special Chars</title></head>
  <body>
    <outline type="rss" text="Feed &amp; News &quot;Test&quot;" xmlUrl="https://example.com/feed?a=1&amp;b=2" htmlUrl="https://example.com" />
    <outline type="rss" text="中文标题" xmlUrl="https://chinese.example.com/feed.xml" />
    <outline type="rss" text="Émojis 🎉" xmlUrl="https://emoji.example.com/feed.xml" />
  </body>
</opml>`;

      const result = await caller.subscriptions.import({ opml });

      expect(result.totalFeeds).toBe(3);
    });
  });

  describe("imports.preview", () => {
    it("parses OPML server-side and returns the feed list without importing", async () => {
      const userId = await createTestUser();
      const ctx = await createAuthContext(userId);
      const caller = createCaller(ctx);

      const result = await caller.imports.preview({ opml: generateOpml(3) });

      expect(result.feeds).toHaveLength(3);
      expect(result.feeds[0]).toMatchObject({
        title: "Feed 1",
        xmlUrl: "https://example1.com/feed.xml",
        htmlUrl: "https://example1.com",
      });

      // Preview must not create an import record or subscriptions
      const imports = await db.select().from(opmlImports);
      expect(imports).toHaveLength(0);
      const subs = await db.select().from(subscriptions);
      expect(subs).toHaveLength(0);
    });

    it("rejects invalid OPML with a validation error", async () => {
      const userId = await createTestUser();
      const ctx = await createAuthContext(userId);
      const caller = createCaller(ctx);

      await expect(
        caller.imports.preview({ opml: "<rss><channel></channel></rss>" })
      ).rejects.toThrow("Failed to parse OPML");
    });
  });

  describe("imports.get", () => {
    it("retrieves import status", async () => {
      const userId = await createTestUser();
      const ctx = await createAuthContext(userId);
      const caller = createCaller(ctx);

      // First create an import
      const opml = generateOpml(5);
      const importResult = await caller.subscriptions.import({ opml });

      // Then retrieve its status
      const status = await caller.imports.get({ id: importResult.importId });

      expect(status.id).toBe(importResult.importId);
      expect(status.status).toBe("pending");
      expect(status.totalFeeds).toBe(5);
      expect(status.importedCount).toBe(0);
      expect(status.skippedCount).toBe(0);
      expect(status.failedCount).toBe(0);
    });

    it("rejects access to another user's import", async () => {
      const userId1 = await createTestUser();
      const userId2 = await createTestUser({ emailPrefix: "other" });

      // User 1 creates an import
      const ctx1 = await createAuthContext(userId1);
      const caller1 = createCaller(ctx1);
      const opml = generateOpml(3);
      const importResult = await caller1.subscriptions.import({ opml });

      // User 2 tries to access it
      const ctx2 = await createAuthContext(userId2);
      const caller2 = createCaller(ctx2);

      await expect(caller2.imports.get({ id: importResult.importId })).rejects.toThrow(
        "Import not found"
      );
    });
  });

  describe("imports.list", () => {
    it("lists user imports", async () => {
      const userId = await createTestUser();
      const ctx = await createAuthContext(userId);
      const caller = createCaller(ctx);

      // Create multiple imports
      await caller.subscriptions.import({ opml: generateOpml(3) });
      await caller.subscriptions.import({ opml: generateOpml(5) });

      const result = await caller.imports.list();

      expect(result.items).toHaveLength(2);
      // Should be ordered by creation date (newest first)
      expect(result.items[0].totalFeeds).toBe(5);
      expect(result.items[1].totalFeeds).toBe(3);
    });

    it("returns empty list for user with no imports", async () => {
      const userId = await createTestUser();
      const ctx = await createAuthContext(userId);
      const caller = createCaller(ctx);

      const result = await caller.imports.list();

      expect(result.items).toEqual([]);
    });
  });

  describe("database insert directly", () => {
    it("inserts import record with large feeds_data", async () => {
      const userId = await createTestUser();

      // Create a large feeds_data array similar to what would come from OPML
      const feedsData: OpmlImportFeedData[] = Array.from({ length: 550 }, (_, i) => ({
        xmlUrl: `https://example${i + 1}.com/feed.xml`,
        title: `Feed ${i + 1}`,
        htmlUrl: `https://example${i + 1}.com`,
      }));

      const importId = generateUuidv7();
      const now = new Date();

      // This is the same insert that happens in the subscriptions.import handler
      await db.insert(opmlImports).values({
        id: importId,
        userId,
        status: "pending",
        totalFeeds: feedsData.length,
        importedCount: 0,
        skippedCount: 0,
        failedCount: 0,
        feedsData,
        results: [],
        createdAt: now,
        updatedAt: now,
      });

      // Verify it was inserted
      const record = await db
        .select()
        .from(opmlImports)
        .where(eq(opmlImports.id, importId))
        .limit(1);

      expect(record).toHaveLength(1);
      expect(record[0].feedsData).toHaveLength(550);
    });
  });

  describe("processOpmlImport", () => {
    it("subscribes to each feed, applies category tags, and completes the import", async () => {
      const userId = await createTestUser();
      const importId = await seedImport(userId, [
        { xmlUrl: "https://a.example.com/feed.xml", title: "A", category: ["News"] },
        { xmlUrl: "https://b.example.com/feed.xml", title: "B", category: ["News"] },
        { xmlUrl: "https://c.example.com/feed.xml", title: "C" },
      ]);

      const result = await processOpmlImport(db, importId);

      expect(result).toEqual({
        status: "completed",
        recovered: false,
        counts: { imported: 3, skipped: 0, failed: 0, total: 3 },
      });

      expect(await subscribedUrls(userId)).toEqual([
        "https://a.example.com/feed.xml",
        "https://b.example.com/feed.xml",
        "https://c.example.com/feed.xml",
      ]);

      // The category is created once and attached to both feeds that named it.
      const taggedSubscriptions = await db
        .select({ feedUrl: feeds.url, tagName: tags.name })
        .from(subscriptionTags)
        .innerJoin(subscriptions, eq(subscriptionTags.subscriptionId, subscriptions.id))
        .innerJoin(feeds, eq(subscriptions.feedId, feeds.id))
        .innerJoin(tags, eq(subscriptionTags.tagId, tags.id))
        .where(eq(subscriptions.userId, userId));

      expect(taggedSubscriptions.map((t) => t.feedUrl).sort()).toEqual([
        "https://a.example.com/feed.xml",
        "https://b.example.com/feed.xml",
      ]);
      expect(new Set(taggedSubscriptions.map((t) => t.tagName))).toEqual(new Set(["News"]));

      const [record] = await db
        .select()
        .from(opmlImports)
        .where(eq(opmlImports.id, importId))
        .limit(1);
      expect(record.status).toBe("completed");
      expect(record.importedCount).toBe(3);
      expect(record.completedAt).not.toBeNull();
      expect(record.results.map((r) => r.status)).toEqual(["imported", "imported", "imported"]);
    });

    it("skips feeds the user is already subscribed to", async () => {
      const userId = await createTestUser();
      const url = "https://already.example.com/feed.xml";
      const feedId = await createTestFeed({ url });
      await createTestSubscription(userId, feedId);

      const importId = await seedImport(userId, [
        { xmlUrl: url, title: "Already subscribed" },
        { xmlUrl: "https://new.example.com/feed.xml", title: "New" },
      ]);

      const result = await processOpmlImport(db, importId);

      expect(result).toEqual({
        status: "completed",
        recovered: false,
        counts: { imported: 1, skipped: 1, failed: 0, total: 2 },
      });
      expect(await subscribedUrls(userId)).toEqual([url, "https://new.example.com/feed.xml"]);
    });

    it("does nothing for an import a previous run already finished", async () => {
      const userId = await createTestUser();
      const importId = await seedImport(userId, [{ xmlUrl: "https://a.example.com/feed.xml" }], {
        status: "completed",
      });

      expect(await processOpmlImport(db, importId)).toEqual({ status: "already_finished" });
      expect(await subscribedUrls(userId)).toEqual([]);
    });

    it("recovers an import whose feeds were processed but never marked completed", async () => {
      const userId = await createTestUser();
      const url = "https://a.example.com/feed.xml";
      const importId = await seedImport(userId, [{ xmlUrl: url, title: "A" }], {
        status: "processing",
        results: [{ url, title: "A", status: "imported" }],
      });

      const result = await processOpmlImport(db, importId);

      expect(result).toEqual({
        status: "completed",
        recovered: true,
        counts: { imported: 1, skipped: 0, failed: 0, total: 1 },
      });
      // Recovery only writes the final status — it must not re-subscribe.
      expect(await subscribedUrls(userId)).toEqual([]);

      const [record] = await db
        .select()
        .from(opmlImports)
        .where(eq(opmlImports.id, importId))
        .limit(1);
      expect(record.status).toBe("completed");
      expect(record.importedCount).toBe(1);
    });

    it("reports a missing import record", async () => {
      expect(await processOpmlImport(db, generateUuidv7())).toEqual({ status: "not_found" });
    });
  });
});

/**
 * Integration tests for OPML import functionality.
 *
 * These tests use a real database to verify OPML import operations,
 * including large imports that might trigger edge cases.
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/server/db";
import {
  users,
  feeds,
  subscriptions,
  opmlImports,
  type OpmlImportFeedData,
} from "../../src/server/db/schema";
import { generateUuidv7 } from "../../src/lib/uuidv7";
import { createCaller } from "../../src/server/trpc/root";
import type { Context } from "../../src/server/trpc/context";

// ============================================================================
// Test Helpers
// ============================================================================

/**
 * Creates a test user and returns their ID.
 */
async function createTestUser(emailPrefix: string = "user"): Promise<string> {
  const userId = generateUuidv7();
  await db.insert(users).values({
    id: userId,
    email: `${emailPrefix}-${userId}@test.com`,
    passwordHash: "test-hash",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return userId;
}

/**
 * Creates an authenticated context for a test user.
 */
function createAuthContext(userId: string): Context {
  const now = new Date();
  return {
    db,
    session: {
      session: {
        id: generateUuidv7(),
        userId,
        tokenHash: "test-hash",
        userAgent: null,
        ipAddress: null,
        createdAt: now,
        expiresAt: new Date(Date.now() + 3600000),
        revokedAt: null,
        lastActiveAt: now,
      },
      user: {
        id: userId,
        email: `${userId}@test.com`,
        emailVerifiedAt: null,
        passwordHash: "test-hash",
        inviteId: null,
        showSpam: false,
        createdAt: now,
        updatedAt: now,
      },
    },
    sessionToken: "test-token",
    headers: new Headers(),
  };
}

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

// ============================================================================
// Tests
// ============================================================================

describe("OPML Import", () => {
  // Clean up tables before each test
  beforeEach(async () => {
    await db.delete(opmlImports);
    await db.delete(subscriptions);
    await db.delete(feeds);
    await db.delete(users);
  });

  // Clean up after all tests
  afterAll(async () => {
    await db.delete(opmlImports);
    await db.delete(subscriptions);
    await db.delete(feeds);
    await db.delete(users);
  });

  describe("subscriptions.import", () => {
    it("imports a simple OPML with few feeds", async () => {
      const userId = await createTestUser();
      const ctx = createAuthContext(userId);
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
      const ctx = createAuthContext(userId);
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
      const ctx = createAuthContext(userId);
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
      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);

      const invalidOpml = "not valid xml at all";

      await expect(caller.subscriptions.import({ opml: invalidOpml })).rejects.toThrow(
        "Failed to parse OPML"
      );
    });

    it("handles OPML with special characters in feed titles", async () => {
      const userId = await createTestUser();
      const ctx = createAuthContext(userId);
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

  describe("imports.get", () => {
    it("retrieves import status", async () => {
      const userId = await createTestUser();
      const ctx = createAuthContext(userId);
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
      const userId2 = await createTestUser("other");

      // User 1 creates an import
      const ctx1 = createAuthContext(userId1);
      const caller1 = createCaller(ctx1);
      const opml = generateOpml(3);
      const importResult = await caller1.subscriptions.import({ opml });

      // User 2 tries to access it
      const ctx2 = createAuthContext(userId2);
      const caller2 = createCaller(ctx2);

      await expect(caller2.imports.get({ id: importResult.importId })).rejects.toThrow(
        "Import not found"
      );
    });
  });

  describe("imports.list", () => {
    it("lists user imports", async () => {
      const userId = await createTestUser();
      const ctx = createAuthContext(userId);
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
      const ctx = createAuthContext(userId);
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
});

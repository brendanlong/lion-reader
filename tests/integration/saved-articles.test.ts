/**
 * Integration tests for the Saved Articles API.
 *
 * These tests use a real database to verify saved article CRUD operations
 * and the proper handling of user isolation and authorization.
 *
 * Saved articles are stored as entries with type='saved' and use the unified
 * entries.* endpoints for list/get/markRead/star/unstar operations.
 * Only saved.save and saved.delete are specific to saved articles.
 *
 * Note: Tests for the `save` procedure that fetch URLs are limited due to
 * network dependencies.
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { eq, and } from "drizzle-orm";
import { db } from "../../src/server/db";
import { users, entries, userEntries, feeds } from "../../src/server/db/schema";
import { generateUuidv7 } from "../../src/lib/uuidv7";
import { createCaller } from "../../src/server/trpc/root";
import type { Context } from "../../src/server/trpc/context";

// ============================================================================
// Test Helpers
// ============================================================================

/**
 * Creates a test user and returns their ID.
 * Uses a unique email based on the userId to avoid conflicts in parallel tests.
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
        algorithmicFeedEnabled: true,
        groqApiKey: null,
        anthropicApiKey: null,
        summarizationModel: null,
        summarizationMaxWords: null,
        summarizationPrompt: null,
        bestFeedScoreWeight: 1,
        bestFeedUncertaintyWeight: 1,
        createdAt: now,
        updatedAt: now,
      },
    },
    apiToken: null,
    authType: "session",
    scopes: [],
    sessionToken: "test-token",
    headers: new Headers(),
  };
}

function createUnauthContext(): Context {
  return {
    db,
    session: null,
    apiToken: null,
    authType: null,
    scopes: [],
    sessionToken: null,
    headers: new Headers(),
  };
}

/**
 * Creates a test saved article directly in the database.
 * Saved articles are now stored as entries with type='saved'.
 */
async function createTestSavedArticle(
  userId: string,
  options: {
    url?: string;
    title?: string;
    read?: boolean;
    starred?: boolean;
    savedAt?: Date;
  } = {}
): Promise<string> {
  const articleId = generateUuidv7();
  const now = options.savedAt ?? new Date();
  const url = options.url ?? `https://example.com/article-${articleId}`;

  // Get or create the user's saved feed
  let savedFeedId: string;
  const existingFeed = await db
    .select({ id: feeds.id })
    .from(feeds)
    .where(and(eq(feeds.type, "saved"), eq(feeds.userId, userId)))
    .limit(1);

  if (existingFeed.length > 0) {
    savedFeedId = existingFeed[0].id;
  } else {
    savedFeedId = generateUuidv7();
    await db.insert(feeds).values({
      id: savedFeedId,
      type: "saved",
      userId,
      title: "Saved Articles",
      createdAt: now,
      updatedAt: now,
    });
  }

  // Create the entry
  await db.insert(entries).values({
    id: articleId,
    feedId: savedFeedId,
    type: "saved",
    guid: url, // For saved articles, guid = URL
    url,
    title: options.title ?? `Test Article ${articleId}`,
    siteName: "Example Site",
    author: "Test Author",
    imageUrl: "https://example.com/image.jpg",
    contentOriginal: "<html><body>Original content</body></html>",
    contentCleaned: "<article>Cleaned content</article>",
    summary: "This is a test excerpt for the article.",
    contentHash: "test-hash",
    publishedAt: now,
    fetchedAt: now,
    createdAt: now,
    updatedAt: now,
  });

  // Create the user_entries row
  // Set timestamps slightly in the past to ensure API calls (with current time) can always update them
  const pastTime = new Date(Date.now() - 1000);
  await db.insert(userEntries).values({
    userId,
    entryId: articleId,
    read: options.read ?? false,
    starred: options.starred ?? false,
    readChangedAt: pastTime,
    starredChangedAt: pastTime,
  });

  return articleId;
}

// ============================================================================
// Tests
// ============================================================================

describe("Saved Articles API", () => {
  // Clean up tables before each test
  beforeEach(async () => {
    await db.delete(userEntries);
    await db.delete(entries);
    await db.delete(feeds);
    await db.delete(users);
  });

  // Clean up after all tests
  afterAll(async () => {
    await db.delete(userEntries);
    await db.delete(entries);
    await db.delete(feeds);
    await db.delete(users);
  });

  describe("entries.list with type='saved'", () => {
    it("returns empty list for user with no saved articles", async () => {
      const userId = await createTestUser();
      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);

      const result = await caller.entries.list({ type: "saved" });

      expect(result.items).toEqual([]);
      expect(result.nextCursor).toBeUndefined();
    });

    it("returns saved articles for the authenticated user only", async () => {
      const userId1 = await createTestUser();
      const userId2 = await createTestUser("other");

      // Create articles for both users
      await createTestSavedArticle(userId1, { title: "User 1 Article 1" });
      await createTestSavedArticle(userId1, { title: "User 1 Article 2" });
      await createTestSavedArticle(userId2, { title: "User 2 Article" });

      const ctx1 = createAuthContext(userId1);
      const caller1 = createCaller(ctx1);
      const result1 = await caller1.entries.list({ type: "saved" });

      expect(result1.items).toHaveLength(2);
      expect(result1.items.map((a) => a.title).sort()).toEqual([
        "User 1 Article 1",
        "User 1 Article 2",
      ]);

      const ctx2 = createAuthContext(userId2);
      const caller2 = createCaller(ctx2);
      const result2 = await caller2.entries.list({ type: "saved" });

      expect(result2.items).toHaveLength(1);
      expect(result2.items[0].title).toBe("User 2 Article");
    });

    it("returns articles ordered by ID descending (newest first)", async () => {
      const userId = await createTestUser();

      // Create articles with slight delay to ensure different UUIDv7s
      const id1 = await createTestSavedArticle(userId, { title: "First" });
      await new Promise((resolve) => setTimeout(resolve, 10));
      const id2 = await createTestSavedArticle(userId, { title: "Second" });
      await new Promise((resolve) => setTimeout(resolve, 10));
      const id3 = await createTestSavedArticle(userId, { title: "Third" });

      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);
      const result = await caller.entries.list({ type: "saved" });

      expect(result.items).toHaveLength(3);
      expect(result.items[0].id).toBe(id3);
      expect(result.items[1].id).toBe(id2);
      expect(result.items[2].id).toBe(id1);
    });

    it("filters by unreadOnly", async () => {
      const userId = await createTestUser();

      await createTestSavedArticle(userId, { title: "Read Article", read: true });
      await createTestSavedArticle(userId, { title: "Unread Article", read: false });

      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);
      const result = await caller.entries.list({ type: "saved", unreadOnly: true });

      expect(result.items).toHaveLength(1);
      expect(result.items[0].title).toBe("Unread Article");
    });

    it("filters by starredOnly", async () => {
      const userId = await createTestUser();

      await createTestSavedArticle(userId, { title: "Starred Article", starred: true });
      await createTestSavedArticle(userId, { title: "Unstarred Article", starred: false });

      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);
      const result = await caller.entries.list({ type: "saved", starredOnly: true });

      expect(result.items).toHaveLength(1);
      expect(result.items[0].title).toBe("Starred Article");
    });

    it("combines unreadOnly and starredOnly filters", async () => {
      const userId = await createTestUser();

      await createTestSavedArticle(userId, {
        title: "Read and Starred",
        read: true,
        starred: true,
      });
      await createTestSavedArticle(userId, {
        title: "Unread and Starred",
        read: false,
        starred: true,
      });
      await createTestSavedArticle(userId, {
        title: "Unread and Unstarred",
        read: false,
        starred: false,
      });

      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);
      const result = await caller.entries.list({
        type: "saved",
        unreadOnly: true,
        starredOnly: true,
      });

      expect(result.items).toHaveLength(1);
      expect(result.items[0].title).toBe("Unread and Starred");
    });

    it("supports cursor-based pagination", async () => {
      const userId = await createTestUser();

      // Create 5 articles
      for (let i = 1; i <= 5; i++) {
        await createTestSavedArticle(userId, { title: `Article ${i}` });
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);

      // Get first page (2 items)
      const page1 = await caller.entries.list({ type: "saved", limit: 2 });
      expect(page1.items).toHaveLength(2);
      expect(page1.nextCursor).toBeDefined();

      // Get second page
      const page2 = await caller.entries.list({
        type: "saved",
        limit: 2,
        cursor: page1.nextCursor,
      });
      expect(page2.items).toHaveLength(2);
      expect(page2.nextCursor).toBeDefined();

      // Get third page
      const page3 = await caller.entries.list({
        type: "saved",
        limit: 2,
        cursor: page2.nextCursor,
      });
      expect(page3.items).toHaveLength(1);
      expect(page3.nextCursor).toBeUndefined();

      // Verify no duplicates
      const allIds = [...page1.items, ...page2.items, ...page3.items].map((a) => a.id);
      expect(new Set(allIds).size).toBe(5);
    });

    it("respects limit parameter", async () => {
      const userId = await createTestUser();

      for (let i = 1; i <= 10; i++) {
        await createTestSavedArticle(userId, { title: `Article ${i}` });
      }

      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);
      const result = await caller.entries.list({ type: "saved", limit: 3 });

      expect(result.items).toHaveLength(3);
      expect(result.nextCursor).toBeDefined();
    });
  });

  describe("entries.get for saved articles", () => {
    it("returns a saved article with full content", async () => {
      const userId = await createTestUser();
      const articleId = await createTestSavedArticle(userId, { title: "Test Article" });

      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);
      const result = await caller.entries.get({ id: articleId });

      expect(result.entry.id).toBe(articleId);
      expect(result.entry.title).toBe("Test Article");
      expect(result.entry.contentOriginal).toBe("<html><body>Original content</body></html>");
      expect(result.entry.contentCleaned).toBe("<article>Cleaned content</article>");
      expect(result.entry.summary).toBe("This is a test excerpt for the article.");
    });

    it("throws error for non-existent article", async () => {
      const userId = await createTestUser();
      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);

      await expect(caller.entries.get({ id: generateUuidv7() })).rejects.toThrow("Entry not found");
    });

    it("throws error when accessing another user's article", async () => {
      const userId1 = await createTestUser();
      const userId2 = await createTestUser("other");

      const articleId = await createTestSavedArticle(userId1, { title: "User 1's Article" });

      const ctx = createAuthContext(userId2);
      const caller = createCaller(ctx);

      await expect(caller.entries.get({ id: articleId })).rejects.toThrow("Entry not found");
    });
  });

  describe("saved.delete", () => {
    it("deletes a saved article", async () => {
      const userId = await createTestUser();
      const articleId = await createTestSavedArticle(userId, { title: "To Delete" });

      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);

      const result = await caller.saved.delete({ id: articleId });
      expect(result).toEqual({});

      // Verify deleted
      const dbArticle = await db.select().from(entries).where(eq(entries.id, articleId)).limit(1);
      expect(dbArticle).toHaveLength(0);
    });

    it("throws error for non-existent article", async () => {
      const userId = await createTestUser();
      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);

      await expect(caller.saved.delete({ id: generateUuidv7() })).rejects.toThrow(
        "Saved article not found"
      );
    });

    it("throws error when deleting another user's article", async () => {
      const userId1 = await createTestUser();
      const userId2 = await createTestUser("other");

      const articleId = await createTestSavedArticle(userId1, { title: "User 1's Article" });

      const ctx = createAuthContext(userId2);
      const caller = createCaller(ctx);

      await expect(caller.saved.delete({ id: articleId })).rejects.toThrow(
        "Saved article not found"
      );

      // Verify not deleted
      const dbArticle = await db.select().from(entries).where(eq(entries.id, articleId)).limit(1);
      expect(dbArticle).toHaveLength(1);
    });
  });

  describe("entries.markRead for saved articles", () => {
    it("marks articles as read", async () => {
      const userId = await createTestUser();
      const id1 = await createTestSavedArticle(userId, { read: false });
      const id2 = await createTestSavedArticle(userId, { read: false });

      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);

      const result = await caller.entries.markRead({
        entries: [{ id: id1 }, { id: id2 }],
        read: true,
      });
      expect(result.success).toBe(true);
      expect(result.count).toBe(2);

      // Verify both are read in user_entries
      const userEntriesResults = await db
        .select()
        .from(userEntries)
        .where(eq(userEntries.userId, userId));
      expect(userEntriesResults.every((a) => a.read === true)).toBe(true);
    });

    it("marks articles as unread", async () => {
      const userId = await createTestUser();
      const id1 = await createTestSavedArticle(userId, { read: true });
      const id2 = await createTestSavedArticle(userId, { read: true });

      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);

      const result = await caller.entries.markRead({
        entries: [{ id: id1 }, { id: id2 }],
        read: false,
      });
      expect(result.success).toBe(true);
      expect(result.count).toBe(2);

      // Verify both are unread in user_entries
      const userEntriesResults = await db
        .select()
        .from(userEntries)
        .where(eq(userEntries.userId, userId));
      expect(userEntriesResults.every((a) => a.read === false)).toBe(true);
    });

    it("ignores non-existent article IDs", async () => {
      const userId = await createTestUser();
      const validId = await createTestSavedArticle(userId, { read: false });

      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);

      // Should not throw, just ignore invalid ID
      const result = await caller.entries.markRead({
        entries: [{ id: validId }, { id: generateUuidv7() }],
        read: true,
      });
      // Only the valid article is counted
      expect(result.success).toBe(true);
      expect(result.count).toBe(1);

      // Verify valid article is updated in user_entries
      const dbUserEntry = await db
        .select()
        .from(userEntries)
        .where(eq(userEntries.entryId, validId))
        .limit(1);
      expect(dbUserEntry[0].read).toBe(true);
    });

    it("ignores articles belonging to other users", async () => {
      const userId1 = await createTestUser();
      const userId2 = await createTestUser("other");

      const myArticle = await createTestSavedArticle(userId1, { read: false });
      const otherArticle = await createTestSavedArticle(userId2, { read: false });

      const ctx = createAuthContext(userId1);
      const caller = createCaller(ctx);

      await caller.entries.markRead({
        entries: [{ id: myArticle }, { id: otherArticle }],
        read: true,
      });

      // My article should be updated in user_entries
      const myResult = await db
        .select()
        .from(userEntries)
        .where(and(eq(userEntries.entryId, myArticle), eq(userEntries.userId, userId1)))
        .limit(1);
      expect(myResult[0].read).toBe(true);

      // Other user's article should not be updated
      const otherResult = await db
        .select()
        .from(userEntries)
        .where(and(eq(userEntries.entryId, otherArticle), eq(userEntries.userId, userId2)))
        .limit(1);
      expect(otherResult[0].read).toBe(false);
    });

    it("returns empty articles array when no valid IDs provided", async () => {
      const userId = await createTestUser();
      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);

      const result = await caller.entries.markRead({
        entries: [{ id: generateUuidv7() }],
        read: true,
      });
      expect(result.success).toBe(true);
      expect(result.count).toBe(0);
    });
  });

  describe("entries.star for saved articles", () => {
    it("stars a saved article", async () => {
      const userId = await createTestUser();
      const articleId = await createTestSavedArticle(userId, { starred: false });

      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);

      const result = await caller.entries.setStarred({ id: articleId, starred: true });
      expect(result.entry.id).toBe(articleId);
      expect(result.entry.starred).toBe(true);
      expect(result.entry.read).toBe(false);

      // Verify starred in user_entries
      const dbUserEntry = await db
        .select()
        .from(userEntries)
        .where(eq(userEntries.entryId, articleId))
        .limit(1);
      expect(dbUserEntry[0].starred).toBe(true);
    });

    it("throws error for non-existent article", async () => {
      const userId = await createTestUser();
      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);

      await expect(
        caller.entries.setStarred({ id: generateUuidv7(), starred: true })
      ).rejects.toThrow("Entry not found");
    });

    it("throws error when starring another user's article", async () => {
      const userId1 = await createTestUser();
      const userId2 = await createTestUser("other");

      const articleId = await createTestSavedArticle(userId1, { starred: false });

      const ctx = createAuthContext(userId2);
      const caller = createCaller(ctx);

      await expect(caller.entries.setStarred({ id: articleId, starred: true })).rejects.toThrow(
        "Entry not found"
      );

      // Verify not starred in user_entries
      const dbUserEntry = await db
        .select()
        .from(userEntries)
        .where(and(eq(userEntries.entryId, articleId), eq(userEntries.userId, userId1)))
        .limit(1);
      expect(dbUserEntry[0].starred).toBe(false);
    });
  });

  describe("entries.unstar for saved articles", () => {
    it("unstars a saved article", async () => {
      const userId = await createTestUser();
      const articleId = await createTestSavedArticle(userId, { starred: true });

      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);

      const result = await caller.entries.setStarred({ id: articleId, starred: false });
      expect(result.entry.id).toBe(articleId);
      expect(result.entry.starred).toBe(false);
      expect(result.entry.read).toBe(false);

      // Verify unstarred in user_entries
      const dbUserEntry = await db
        .select()
        .from(userEntries)
        .where(eq(userEntries.entryId, articleId))
        .limit(1);
      expect(dbUserEntry[0].starred).toBe(false);
    });

    it("throws error for non-existent article", async () => {
      const userId = await createTestUser();
      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);

      await expect(
        caller.entries.setStarred({ id: generateUuidv7(), starred: false })
      ).rejects.toThrow("Entry not found");
    });

    it("throws error when unstarring another user's article", async () => {
      const userId1 = await createTestUser();
      const userId2 = await createTestUser("other");

      const articleId = await createTestSavedArticle(userId1, { starred: true });

      const ctx = createAuthContext(userId2);
      const caller = createCaller(ctx);

      await expect(caller.entries.setStarred({ id: articleId, starred: false })).rejects.toThrow(
        "Entry not found"
      );

      // Verify still starred in user_entries
      const dbUserEntry = await db
        .select()
        .from(userEntries)
        .where(and(eq(userEntries.entryId, articleId), eq(userEntries.userId, userId1)))
        .limit(1);
      expect(dbUserEntry[0].starred).toBe(true);
    });
  });

  describe("authentication", () => {
    it("requires authentication for list", async () => {
      const ctx = createUnauthContext();
      const caller = createCaller(ctx);

      await expect(caller.entries.list({ type: "saved" })).rejects.toThrow("You must be logged in");
    });

    it("requires authentication for get", async () => {
      const ctx = createUnauthContext();
      const caller = createCaller(ctx);

      await expect(caller.entries.get({ id: generateUuidv7() })).rejects.toThrow(
        "You must be logged in"
      );
    });

    it("requires authentication for delete", async () => {
      const ctx = createUnauthContext();
      const caller = createCaller(ctx);

      await expect(caller.saved.delete({ id: generateUuidv7() })).rejects.toThrow(
        "You must be logged in"
      );
    });

    it("requires authentication for markRead", async () => {
      const ctx = createUnauthContext();
      const caller = createCaller(ctx);

      await expect(
        caller.entries.markRead({ entries: [{ id: generateUuidv7() }], read: true })
      ).rejects.toThrow("You must be logged in");
    });

    it("requires authentication for setStarred", async () => {
      const ctx = createUnauthContext();
      const caller = createCaller(ctx);

      await expect(
        caller.entries.setStarred({ id: generateUuidv7(), starred: true })
      ).rejects.toThrow("You must be logged in");
    });

    it("requires authentication for save", async () => {
      const ctx = createUnauthContext();
      const caller = createCaller(ctx);

      await expect(caller.saved.save({ url: "https://example.com" })).rejects.toThrow(
        "You must be logged in"
      );
    });
  });

  describe("saved.save with existing URL", () => {
    it("returns existing article without refetching when refetch=false", async () => {
      const userId = await createTestUser();
      const existingUrl = "https://example.com/already-saved";
      const articleId = await createTestSavedArticle(userId, {
        url: existingUrl,
        title: "Already Saved Article",
      });

      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);

      // With refetch=false, returns existing without attempting to fetch
      const result = await caller.saved.save({ url: existingUrl, refetch: false });

      expect(result.article.id).toBe(articleId);
      expect(result.article.title).toBe("Already Saved Article");
      expect(result.article.url).toBe(existingUrl);
    });

    it("allows different users to save the same URL", async () => {
      const userId1 = await createTestUser();
      const userId2 = await createTestUser("other");
      const sharedUrl = "https://example.com/shared";

      // User 1 saves the URL
      await createTestSavedArticle(userId1, { url: sharedUrl, title: "User 1's Copy" });

      // User 2 saves the same URL (verifies URL uniqueness is per-user, not global)
      await createTestSavedArticle(userId2, { url: sharedUrl, title: "User 2's Copy" });

      // Both should have their own copy in entries
      const articles = await db.select().from(entries).where(eq(entries.type, "saved"));
      expect(articles).toHaveLength(2);
      expect(articles.filter((a) => a.url === sharedUrl)).toHaveLength(2);
    });
  });

  describe("saved.save with refetch", () => {
    it("updates content when refetch=true and URL is already saved", async () => {
      const userId = await createTestUser();
      const testUrl = "https://example.com/refetch-test";

      // Create initial article
      await createTestSavedArticle(userId, {
        url: testUrl,
        title: "Original Title",
      });

      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);

      // Refetch with new HTML
      const newHtml = `
        <!DOCTYPE html>
        <html>
          <head>
            <title>Updated Title</title>
            <meta property="og:title" content="Updated OG Title" />
          </head>
          <body>
            <article>
              <p>This is the updated content with plenty of text to pass quality checks.</p>
              <p>The content has been refreshed and updated with new information.</p>
              <p>This is at least 500 characters to be sure it passes the quality check threshold.</p>
            </article>
          </body>
        </html>
      `;

      const result = await caller.saved.save({
        url: testUrl,
        html: newHtml,
        refetch: true,
      });

      // Should return updated content
      expect(result.article.title).toBe("Updated OG Title");
      expect(result.article.contentCleaned).toContain("updated content");
    });

    it("marks as unread but preserves starred state when refetching", async () => {
      const userId = await createTestUser();
      const testUrl = "https://example.com/refetch-preserve-state";

      await createTestSavedArticle(userId, {
        url: testUrl,
        title: "Original Title",
        read: true,
        starred: true,
      });

      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);

      const newHtml = `
        <!DOCTYPE html>
        <html>
          <head><title>New Title</title></head>
          <body>
            <article>
              <p>Sufficient content for quality check to pass with new information.</p>
              <p>The content has been refreshed and updated with new information.</p>
            </article>
          </body>
        </html>
      `;

      const result = await caller.saved.save({
        url: testUrl,
        html: newHtml,
        refetch: true,
      });

      // Article should be marked unread so user sees updated content
      expect(result.article.read).toBe(false);
      // Starred state should be preserved
      expect(result.article.starred).toBe(true);
    });

    it("rejects refetch when new content is significantly shorter", async () => {
      const userId = await createTestUser();
      const testUrl = "https://example.com/refetch-reject-short";

      // Create article with long content
      const articleId = await createTestSavedArticle(userId, {
        url: testUrl,
        title: "Original Title",
      });

      // Update with substantial content
      await db
        .update(entries)
        .set({
          contentCleaned:
            "<article>" + "<p>This is a long piece of content.</p>".repeat(50) + "</article>",
        })
        .where(eq(entries.id, articleId));

      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);

      // Try to refetch with very short content (simulating error page)
      const shortHtml = `
        <!DOCTYPE html>
        <html>
          <head><title>Error</title></head>
          <body><p>Access denied.</p></body>
        </html>
      `;

      await expect(
        caller.saved.save({
          url: testUrl,
          html: shortHtml,
          refetch: true,
        })
      ).rejects.toThrow("REFETCH_CONTENT_WORSE");
    });

    it("allows refetch with force=true even when content is shorter", async () => {
      const userId = await createTestUser();
      const testUrl = "https://example.com/refetch-force";

      // Create article with long content
      const articleId = await createTestSavedArticle(userId, {
        url: testUrl,
        title: "Original Title",
      });

      // Update with substantial content
      await db
        .update(entries)
        .set({
          contentCleaned:
            "<article>" + "<p>This is a long piece of content.</p>".repeat(50) + "</article>",
        })
        .where(eq(entries.id, articleId));

      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);

      // Force refetch with short content
      const shortHtml = `
        <!DOCTYPE html>
        <html>
          <head><title>Short Article</title></head>
          <body><article><p>Brief update.</p></article></body>
        </html>
      `;

      const result = await caller.saved.save({
        url: testUrl,
        html: shortHtml,
        refetch: true,
        force: true,
      });

      // Should update despite shorter content
      expect(result.article.title).toBe("Short Article");
    });

    it("does not reject when new content is only moderately shorter", async () => {
      const userId = await createTestUser();
      const testUrl = "https://example.com/refetch-moderate";

      // Create article with content of about 1000 chars
      const articleId = await createTestSavedArticle(userId, {
        url: testUrl,
        title: "Original Title",
      });

      await db
        .update(entries)
        .set({
          contentCleaned:
            "<article>" + "<p>This is a moderate piece of content.</p>".repeat(25) + "</article>",
        })
        .where(eq(entries.id, articleId));

      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);

      // Refetch with content that's 60% of original but >500 chars
      // This should be allowed since absolute length is still reasonable
      const newHtml = `
        <!DOCTYPE html>
        <html>
          <head><title>Updated</title></head>
          <body>
            <article>
              ${"<p>This is a shortened but still substantial article with plenty of content.</p>".repeat(10)}
            </article>
          </body>
        </html>
      `;

      const result = await caller.saved.save({
        url: testUrl,
        html: newHtml,
        refetch: true,
      });

      expect(result.article.title).toBe("Updated");
    });
  });

  describe("saved.save with provided HTML", () => {
    it("uses provided HTML instead of fetching the URL", async () => {
      const userId = await createTestUser();
      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);

      const testHtml = `
        <!DOCTYPE html>
        <html>
          <head>
            <title>Page Title</title>
            <meta property="og:title" content="OG Title" />
            <meta property="og:site_name" content="Test Site" />
            <meta property="og:image" content="https://example.com/image.jpg" />
            <meta name="author" content="Test Author" />
          </head>
          <body>
            <article>
              <h1>Article Heading</h1>
              <p>This is the article content that should be extracted by Readability.</p>
              <p>It has multiple paragraphs to ensure proper extraction.</p>
            </article>
          </body>
        </html>
      `;

      const result = await caller.saved.save({
        url: "https://example.com/js-rendered-page",
        html: testHtml,
      });

      expect(result.article.url).toBe("https://example.com/js-rendered-page");
      expect(result.article.title).toBe("OG Title");
      expect(result.article.siteName).toBe("Test Site");
      expect(result.article.author).toBe("Test Author");
      expect(result.article.imageUrl).toBe("https://example.com/image.jpg");
      expect(result.article.contentOriginal).toBe(testHtml);
      // Content should be cleaned by Readability
      expect(result.article.contentCleaned).toContain("article content");
    });

    it("uses provided title parameter over extracted metadata", async () => {
      const userId = await createTestUser();
      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);

      const testHtml = `
        <!DOCTYPE html>
        <html>
          <head>
            <title>Page Title from HTML</title>
            <meta property="og:title" content="OG Title from HTML" />
          </head>
          <body>
            <article><p>Content</p></article>
          </body>
        </html>
      `;

      const result = await caller.saved.save({
        url: "https://example.com/with-title-param",
        html: testHtml,
        title: "Title from Bookmarklet",
      });

      // Provided title should take precedence
      expect(result.article.title).toBe("Title from Bookmarklet");
    });

    it("falls back to og:title when title parameter is not provided", async () => {
      const userId = await createTestUser();
      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);

      const testHtml = `
        <!DOCTYPE html>
        <html>
          <head>
            <title>Page Title</title>
            <meta property="og:title" content="OG Title" />
          </head>
          <body><article><p>Content</p></article></body>
        </html>
      `;

      const result = await caller.saved.save({
        url: "https://example.com/og-title-fallback",
        html: testHtml,
      });

      expect(result.article.title).toBe("OG Title");
    });

    it("handles HTML without metadata gracefully", async () => {
      const userId = await createTestUser();
      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);

      const testHtml = `
        <!DOCTYPE html>
        <html>
          <body>
            <article>
              <p>Just some content without any metadata.</p>
              <p>This simulates a minimal page.</p>
            </article>
          </body>
        </html>
      `;

      const result = await caller.saved.save({
        url: "https://example.com/no-metadata",
        html: testHtml,
        title: "Fallback Title",
      });

      expect(result.article.url).toBe("https://example.com/no-metadata");
      expect(result.article.title).toBe("Fallback Title");
      expect(result.article.siteName).toBeNull();
      expect(result.article.author).toBeNull();
      expect(result.article.imageUrl).toBeNull();
    });
  });
});

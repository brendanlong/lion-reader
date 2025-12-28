/**
 * Integration tests for the Saved Articles API.
 *
 * These tests use a real database to verify saved article CRUD operations
 * and the proper handling of user isolation and authorization.
 *
 * Note: Tests for the `save` procedure that fetch URLs are limited due to
 * network dependencies. We test list/get/delete/markRead/star/unstar thoroughly.
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/server/db";
import { users, savedArticles } from "../../src/server/db/schema";
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
        createdAt: now,
        updatedAt: now,
      },
    },
    sessionToken: "test-token",
    headers: new Headers(),
  };
}

/**
 * Creates a test saved article directly in the database.
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
  await db.insert(savedArticles).values({
    id: articleId,
    userId,
    url: options.url ?? `https://example.com/article-${articleId}`,
    title: options.title ?? `Test Article ${articleId}`,
    siteName: "Example Site",
    author: "Test Author",
    imageUrl: "https://example.com/image.jpg",
    contentOriginal: "<html><body>Original content</body></html>",
    contentCleaned: "<article>Cleaned content</article>",
    excerpt: "This is a test excerpt for the article.",
    read: options.read ?? false,
    readAt: options.read ? now : null,
    starred: options.starred ?? false,
    starredAt: options.starred ? now : null,
    savedAt: now,
    createdAt: now,
    updatedAt: now,
  });
  return articleId;
}

// ============================================================================
// Tests
// ============================================================================

describe("Saved Articles API", () => {
  // Clean up tables before each test
  beforeEach(async () => {
    await db.delete(savedArticles);
    await db.delete(users);
  });

  // Clean up after all tests
  afterAll(async () => {
    await db.delete(savedArticles);
    await db.delete(users);
  });

  describe("saved.list", () => {
    it("returns empty list for user with no saved articles", async () => {
      const userId = await createTestUser();
      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);

      const result = await caller.saved.list({});

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
      const result1 = await caller1.saved.list({});

      expect(result1.items).toHaveLength(2);
      expect(result1.items.map((a) => a.title).sort()).toEqual([
        "User 1 Article 1",
        "User 1 Article 2",
      ]);

      const ctx2 = createAuthContext(userId2);
      const caller2 = createCaller(ctx2);
      const result2 = await caller2.saved.list({});

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
      const result = await caller.saved.list({});

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
      const result = await caller.saved.list({ unreadOnly: true });

      expect(result.items).toHaveLength(1);
      expect(result.items[0].title).toBe("Unread Article");
    });

    it("filters by starredOnly", async () => {
      const userId = await createTestUser();

      await createTestSavedArticle(userId, { title: "Starred Article", starred: true });
      await createTestSavedArticle(userId, { title: "Unstarred Article", starred: false });

      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);
      const result = await caller.saved.list({ starredOnly: true });

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
      const result = await caller.saved.list({ unreadOnly: true, starredOnly: true });

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
      const page1 = await caller.saved.list({ limit: 2 });
      expect(page1.items).toHaveLength(2);
      expect(page1.nextCursor).toBeDefined();

      // Get second page
      const page2 = await caller.saved.list({ limit: 2, cursor: page1.nextCursor });
      expect(page2.items).toHaveLength(2);
      expect(page2.nextCursor).toBeDefined();

      // Get third page
      const page3 = await caller.saved.list({ limit: 2, cursor: page2.nextCursor });
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
      const result = await caller.saved.list({ limit: 3 });

      expect(result.items).toHaveLength(3);
      expect(result.nextCursor).toBeDefined();
    });
  });

  describe("saved.get", () => {
    it("returns a saved article with full content", async () => {
      const userId = await createTestUser();
      const articleId = await createTestSavedArticle(userId, { title: "Test Article" });

      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);
      const result = await caller.saved.get({ id: articleId });

      expect(result.article.id).toBe(articleId);
      expect(result.article.title).toBe("Test Article");
      expect(result.article.contentOriginal).toBe("<html><body>Original content</body></html>");
      expect(result.article.contentCleaned).toBe("<article>Cleaned content</article>");
      expect(result.article.excerpt).toBe("This is a test excerpt for the article.");
    });

    it("throws error for non-existent article", async () => {
      const userId = await createTestUser();
      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);

      await expect(caller.saved.get({ id: generateUuidv7() })).rejects.toThrow(
        "Saved article not found"
      );
    });

    it("throws error when accessing another user's article", async () => {
      const userId1 = await createTestUser();
      const userId2 = await createTestUser("other");

      const articleId = await createTestSavedArticle(userId1, { title: "User 1's Article" });

      const ctx = createAuthContext(userId2);
      const caller = createCaller(ctx);

      await expect(caller.saved.get({ id: articleId })).rejects.toThrow("Saved article not found");
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
      const dbArticle = await db
        .select()
        .from(savedArticles)
        .where(eq(savedArticles.id, articleId))
        .limit(1);
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
      const dbArticle = await db
        .select()
        .from(savedArticles)
        .where(eq(savedArticles.id, articleId))
        .limit(1);
      expect(dbArticle).toHaveLength(1);
    });
  });

  describe("saved.markRead", () => {
    it("marks articles as read", async () => {
      const userId = await createTestUser();
      const id1 = await createTestSavedArticle(userId, { read: false });
      const id2 = await createTestSavedArticle(userId, { read: false });

      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);

      const result = await caller.saved.markRead({ ids: [id1, id2], read: true });
      expect(result).toEqual({});

      // Verify both are read
      const articles = await db
        .select()
        .from(savedArticles)
        .where(eq(savedArticles.userId, userId));
      expect(articles.every((a) => a.read === true)).toBe(true);
      expect(articles.every((a) => a.readAt !== null)).toBe(true);
    });

    it("marks articles as unread", async () => {
      const userId = await createTestUser();
      const id1 = await createTestSavedArticle(userId, { read: true });
      const id2 = await createTestSavedArticle(userId, { read: true });

      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);

      const result = await caller.saved.markRead({ ids: [id1, id2], read: false });
      expect(result).toEqual({});

      // Verify both are unread
      const articles = await db
        .select()
        .from(savedArticles)
        .where(eq(savedArticles.userId, userId));
      expect(articles.every((a) => a.read === false)).toBe(true);
      expect(articles.every((a) => a.readAt === null)).toBe(true);
    });

    it("ignores non-existent article IDs", async () => {
      const userId = await createTestUser();
      const validId = await createTestSavedArticle(userId, { read: false });

      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);

      // Should not throw, just ignore invalid ID
      const result = await caller.saved.markRead({
        ids: [validId, generateUuidv7()],
        read: true,
      });
      expect(result).toEqual({});

      // Verify valid article is updated
      const dbArticle = await db
        .select()
        .from(savedArticles)
        .where(eq(savedArticles.id, validId))
        .limit(1);
      expect(dbArticle[0].read).toBe(true);
    });

    it("ignores articles belonging to other users", async () => {
      const userId1 = await createTestUser();
      const userId2 = await createTestUser("other");

      const myArticle = await createTestSavedArticle(userId1, { read: false });
      const otherArticle = await createTestSavedArticle(userId2, { read: false });

      const ctx = createAuthContext(userId1);
      const caller = createCaller(ctx);

      await caller.saved.markRead({ ids: [myArticle, otherArticle], read: true });

      // My article should be updated
      const myResult = await db
        .select()
        .from(savedArticles)
        .where(eq(savedArticles.id, myArticle))
        .limit(1);
      expect(myResult[0].read).toBe(true);

      // Other user's article should not be updated
      const otherResult = await db
        .select()
        .from(savedArticles)
        .where(eq(savedArticles.id, otherArticle))
        .limit(1);
      expect(otherResult[0].read).toBe(false);
    });

    it("returns empty object when no valid IDs provided", async () => {
      const userId = await createTestUser();
      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);

      const result = await caller.saved.markRead({
        ids: [generateUuidv7()],
        read: true,
      });
      expect(result).toEqual({});
    });
  });

  describe("saved.star", () => {
    it("stars a saved article", async () => {
      const userId = await createTestUser();
      const articleId = await createTestSavedArticle(userId, { starred: false });

      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);

      const result = await caller.saved.star({ id: articleId });
      expect(result).toEqual({});

      // Verify starred
      const dbArticle = await db
        .select()
        .from(savedArticles)
        .where(eq(savedArticles.id, articleId))
        .limit(1);
      expect(dbArticle[0].starred).toBe(true);
      expect(dbArticle[0].starredAt).not.toBeNull();
    });

    it("throws error for non-existent article", async () => {
      const userId = await createTestUser();
      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);

      await expect(caller.saved.star({ id: generateUuidv7() })).rejects.toThrow(
        "Saved article not found"
      );
    });

    it("throws error when starring another user's article", async () => {
      const userId1 = await createTestUser();
      const userId2 = await createTestUser("other");

      const articleId = await createTestSavedArticle(userId1, { starred: false });

      const ctx = createAuthContext(userId2);
      const caller = createCaller(ctx);

      await expect(caller.saved.star({ id: articleId })).rejects.toThrow("Saved article not found");

      // Verify not starred
      const dbArticle = await db
        .select()
        .from(savedArticles)
        .where(eq(savedArticles.id, articleId))
        .limit(1);
      expect(dbArticle[0].starred).toBe(false);
    });
  });

  describe("saved.unstar", () => {
    it("unstars a saved article", async () => {
      const userId = await createTestUser();
      const articleId = await createTestSavedArticle(userId, { starred: true });

      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);

      const result = await caller.saved.unstar({ id: articleId });
      expect(result).toEqual({});

      // Verify unstarred
      const dbArticle = await db
        .select()
        .from(savedArticles)
        .where(eq(savedArticles.id, articleId))
        .limit(1);
      expect(dbArticle[0].starred).toBe(false);
      expect(dbArticle[0].starredAt).toBeNull();
    });

    it("throws error for non-existent article", async () => {
      const userId = await createTestUser();
      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);

      await expect(caller.saved.unstar({ id: generateUuidv7() })).rejects.toThrow(
        "Saved article not found"
      );
    });

    it("throws error when unstarring another user's article", async () => {
      const userId1 = await createTestUser();
      const userId2 = await createTestUser("other");

      const articleId = await createTestSavedArticle(userId1, { starred: true });

      const ctx = createAuthContext(userId2);
      const caller = createCaller(ctx);

      await expect(caller.saved.unstar({ id: articleId })).rejects.toThrow(
        "Saved article not found"
      );

      // Verify still starred
      const dbArticle = await db
        .select()
        .from(savedArticles)
        .where(eq(savedArticles.id, articleId))
        .limit(1);
      expect(dbArticle[0].starred).toBe(true);
    });
  });

  describe("authentication", () => {
    it("requires authentication for list", async () => {
      const ctx: Context = {
        db,
        session: null,
        sessionToken: null,
        headers: new Headers(),
      };
      const caller = createCaller(ctx);

      await expect(caller.saved.list({})).rejects.toThrow("You must be logged in");
    });

    it("requires authentication for get", async () => {
      const ctx: Context = {
        db,
        session: null,
        sessionToken: null,
        headers: new Headers(),
      };
      const caller = createCaller(ctx);

      await expect(caller.saved.get({ id: generateUuidv7() })).rejects.toThrow(
        "You must be logged in"
      );
    });

    it("requires authentication for delete", async () => {
      const ctx: Context = {
        db,
        session: null,
        sessionToken: null,
        headers: new Headers(),
      };
      const caller = createCaller(ctx);

      await expect(caller.saved.delete({ id: generateUuidv7() })).rejects.toThrow(
        "You must be logged in"
      );
    });

    it("requires authentication for markRead", async () => {
      const ctx: Context = {
        db,
        session: null,
        sessionToken: null,
        headers: new Headers(),
      };
      const caller = createCaller(ctx);

      await expect(caller.saved.markRead({ ids: [generateUuidv7()], read: true })).rejects.toThrow(
        "You must be logged in"
      );
    });

    it("requires authentication for star", async () => {
      const ctx: Context = {
        db,
        session: null,
        sessionToken: null,
        headers: new Headers(),
      };
      const caller = createCaller(ctx);

      await expect(caller.saved.star({ id: generateUuidv7() })).rejects.toThrow(
        "You must be logged in"
      );
    });

    it("requires authentication for unstar", async () => {
      const ctx: Context = {
        db,
        session: null,
        sessionToken: null,
        headers: new Headers(),
      };
      const caller = createCaller(ctx);

      await expect(caller.saved.unstar({ id: generateUuidv7() })).rejects.toThrow(
        "You must be logged in"
      );
    });

    it("requires authentication for save", async () => {
      const ctx: Context = {
        db,
        session: null,
        sessionToken: null,
        headers: new Headers(),
      };
      const caller = createCaller(ctx);

      await expect(caller.saved.save({ url: "https://example.com" })).rejects.toThrow(
        "You must be logged in"
      );
    });
  });

  describe("saved.save with existing URL", () => {
    it("returns existing article if URL is already saved", async () => {
      const userId = await createTestUser();
      const existingUrl = "https://example.com/already-saved";
      const articleId = await createTestSavedArticle(userId, {
        url: existingUrl,
        title: "Already Saved Article",
      });

      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);

      // This won't fetch since the URL already exists
      const result = await caller.saved.save({ url: existingUrl });

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

      // Both should have their own copy
      const articles = await db.select().from(savedArticles);
      expect(articles).toHaveLength(2);
      expect(articles.filter((a) => a.url === sharedUrl)).toHaveLength(2);
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

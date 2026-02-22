// Set ADMIN_SECRET before any imports so env.ts reads it at module init time
process.env.ADMIN_SECRET = "test-admin-secret";

/**
 * Integration tests for the Admin tRPC router.
 *
 * These tests use a real database to verify admin operations:
 * invite management, feed health monitoring, and user listing.
 * All endpoints require ALLOWLIST_SECRET Bearer token authentication.
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "../../src/server/db";
import { users, feeds, subscriptions, invites, jobs } from "../../src/server/db/schema";
import { generateUuidv7 } from "../../src/lib/uuidv7";
import { createCaller } from "../../src/server/trpc/root";
import type { Context } from "../../src/server/trpc/context";

// ============================================================================
// Test Helpers
// ============================================================================

/**
 * Creates an admin context with the correct Bearer token in the Authorization header.
 */
function createAdminContext(): Context {
  return {
    db,
    session: null,
    apiToken: null,
    authType: null,
    scopes: [],
    sessionToken: null,
    headers: new Headers({
      authorization: "Bearer test-admin-secret",
    }),
  };
}

/**
 * Creates a context with no authorization header (unauthenticated).
 */
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
 * Creates a context with a wrong Bearer token.
 */
function createWrongTokenContext(): Context {
  return {
    db,
    session: null,
    apiToken: null,
    authType: null,
    scopes: [],
    sessionToken: null,
    headers: new Headers({
      authorization: "Bearer wrong-secret",
    }),
  };
}

/**
 * Creates a test user and returns their ID.
 */
async function createTestUser(emailPrefix: string = "admin-test"): Promise<string> {
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
 * Creates a test web feed and returns its ID.
 */
async function createTestFeed(
  url: string,
  options: { consecutiveFailures?: number; lastError?: string | null; title?: string } = {}
): Promise<string> {
  const feedId = generateUuidv7();
  await db.insert(feeds).values({
    id: feedId,
    type: "web",
    url,
    title: options.title ?? `Test Feed ${feedId}`,
    consecutiveFailures: options.consecutiveFailures ?? 0,
    lastError: options.lastError ?? null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return feedId;
}

/**
 * Creates a test invite directly in the database.
 */
async function createTestInvite(
  options: {
    expiresAt?: Date;
    usedAt?: Date | null;
    usedByUserId?: string | null;
  } = {}
): Promise<{ id: string; token: string }> {
  const id = generateUuidv7();
  const token = `test-token-${id}`;
  const now = new Date();
  const expiresAt = options.expiresAt ?? new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  await db.insert(invites).values({
    id,
    token,
    expiresAt,
    usedAt: options.usedAt ?? null,
    usedByUserId: options.usedByUserId ?? null,
    createdAt: now,
  });

  return { id, token };
}

// ============================================================================
// Tests
// ============================================================================

describe("Admin API", () => {
  // Clean up tables before each test
  beforeEach(async () => {
    // Clear in dependency order
    await db.delete(jobs);
    await db.delete(subscriptions);
    // Clear invite references from users first
    await db.execute(sql`UPDATE users SET invite_id = NULL`);
    await db.delete(invites);
    await db.delete(feeds);
    await db.delete(users);
  });

  // Clean up after all tests
  afterAll(async () => {
    await db.delete(jobs);
    await db.delete(subscriptions);
    await db.execute(sql`UPDATE users SET invite_id = NULL`);
    await db.delete(invites);
    await db.delete(feeds);
    await db.delete(users);
  });

  // ==========================================================================
  // Security Tests
  // ==========================================================================

  describe("security", () => {
    it("fails without auth header", async () => {
      const ctx = createUnauthContext();
      const caller = createCaller(ctx);

      await expect(caller.admin.listUsers()).rejects.toThrow("Invalid admin secret");
    });

    it("fails with wrong token", async () => {
      const ctx = createWrongTokenContext();
      const caller = createCaller(ctx);

      await expect(caller.admin.listUsers()).rejects.toThrow("Invalid admin secret");
    });
  });

  // ==========================================================================
  // Invite Tests
  // ==========================================================================

  describe("admin.createInvite", () => {
    it("creates an invite and returns URL", async () => {
      const ctx = createAdminContext();
      const caller = createCaller(ctx);

      const result = await caller.admin.createInvite();

      expect(result.invite).toBeDefined();
      expect(result.invite.id).toBeDefined();
      expect(result.invite.token).toBeDefined();
      expect(result.invite.expiresAt).toBeInstanceOf(Date);
      expect(result.inviteUrl).toContain(result.invite.token);
      expect(result.inviteUrl).toContain("/register?invite=");

      // Verify invite was persisted in database
      const [dbInvite] = await db.select().from(invites).where(eq(invites.id, result.invite.id));
      expect(dbInvite).toBeDefined();
      expect(dbInvite.token).toBe(result.invite.token);
    });
  });

  describe("admin.listInvites", () => {
    it("lists invites with pagination", async () => {
      const ctx = createAdminContext();
      const caller = createCaller(ctx);

      // Create several invites
      await createTestInvite();
      await createTestInvite();
      await createTestInvite();

      const result = await caller.admin.listInvites({ limit: 2 });

      expect(result.items).toHaveLength(2);
      expect(result.nextCursor).toBeDefined();

      // Fetch next page
      const page2 = await caller.admin.listInvites({
        limit: 2,
        cursor: result.nextCursor,
      });

      expect(page2.items).toHaveLength(1);
      expect(page2.nextCursor).toBeUndefined();
    });

    it("searches invites by used-by user email", async () => {
      const ctx = createAdminContext();
      const caller = createCaller(ctx);

      // Create a user and an invite used by that user
      const userId = await createTestUser("searchable");
      const usedInvite = await createTestInvite({
        usedAt: new Date(),
        usedByUserId: userId,
      });

      // Create another unused invite
      await createTestInvite();

      // Search by the user's email substring
      const result = await caller.admin.listInvites({ search: "searchable" });

      expect(result.items).toHaveLength(1);
      expect(result.items[0].id).toBe(usedInvite.id);
      expect(result.items[0].status).toBe("used");
      expect(result.items[0].usedByEmail).toContain("searchable");
    });
  });

  describe("admin.revokeInvite", () => {
    it("revokes an unused invite", async () => {
      const ctx = createAdminContext();
      const caller = createCaller(ctx);

      const invite = await createTestInvite();

      const result = await caller.admin.revokeInvite({ inviteId: invite.id });

      expect(result.success).toBe(true);

      // Verify invite was deleted from database
      const [dbInvite] = await db.select().from(invites).where(eq(invites.id, invite.id));
      expect(dbInvite).toBeUndefined();
    });
  });

  // ==========================================================================
  // Feed Health Tests
  // ==========================================================================

  describe("admin.listFeeds", () => {
    it("lists all web feeds", async () => {
      const ctx = createAdminContext();
      const caller = createCaller(ctx);

      const feedId1 = await createTestFeed("https://example.com/feed1.xml");
      const feedId2 = await createTestFeed("https://example.com/feed2.xml");

      const result = await caller.admin.listFeeds();

      expect(result.items.length).toBeGreaterThanOrEqual(2);

      const feedIds = result.items.map((f) => f.feedId);
      expect(feedIds).toContain(feedId1);
      expect(feedIds).toContain(feedId2);
    });

    it("filters by URL substring", async () => {
      const ctx = createAdminContext();
      const caller = createCaller(ctx);

      await createTestFeed("https://example.com/unique-feed-abc.xml");
      await createTestFeed("https://other.com/different.xml");

      const result = await caller.admin.listFeeds({ urlFilter: "unique-feed-abc" });

      expect(result.items).toHaveLength(1);
      expect(result.items[0].url).toContain("unique-feed-abc");
    });

    it("filters by broken only", async () => {
      const ctx = createAdminContext();
      const caller = createCaller(ctx);

      await createTestFeed("https://example.com/healthy.xml", { consecutiveFailures: 0 });
      const brokenId = await createTestFeed("https://example.com/broken.xml", {
        consecutiveFailures: 5,
        lastError: "Connection timeout",
      });

      const result = await caller.admin.listFeeds({ brokenOnly: true });

      // All returned feeds should have consecutiveFailures > 0
      for (const feed of result.items) {
        expect(feed.consecutiveFailures).toBeGreaterThan(0);
      }

      const feedIds = result.items.map((f) => f.feedId);
      expect(feedIds).toContain(brokenId);
    });
  });

  describe("admin.retryFeedFetch", () => {
    it("resets feed failure count and schedules immediate fetch", async () => {
      const ctx = createAdminContext();
      const caller = createCaller(ctx);

      const feedId = await createTestFeed("https://example.com/retry-test.xml", {
        consecutiveFailures: 10,
        lastError: "Server error",
      });

      const result = await caller.admin.retryFeedFetch({ feedId });

      expect(result.success).toBe(true);

      // Verify feed was updated in database
      const [updatedFeed] = await db.select().from(feeds).where(eq(feeds.id, feedId));

      expect(updatedFeed.consecutiveFailures).toBe(0);
      expect(updatedFeed.lastError).toBeNull();
      expect(updatedFeed.nextFetchAt).toBeDefined();
    });
  });

  // ==========================================================================
  // User Tests
  // ==========================================================================

  describe("admin.listUsers", () => {
    it("lists all users", async () => {
      const ctx = createAdminContext();
      const caller = createCaller(ctx);

      const userId1 = await createTestUser("user-a");
      const userId2 = await createTestUser("user-b");

      const result = await caller.admin.listUsers();

      expect(result.items.length).toBeGreaterThanOrEqual(2);

      const userIds = result.items.map((u) => u.id);
      expect(userIds).toContain(userId1);
      expect(userIds).toContain(userId2);

      // Verify response shape
      const user = result.items.find((u) => u.id === userId1);
      expect(user).toBeDefined();
      expect(user!.email).toContain("user-a");
      expect(user!.createdAt).toBeInstanceOf(Date);
      expect(Array.isArray(user!.providers)).toBe(true);
      expect(typeof user!.subscriptionCount).toBe("number");
      expect(typeof user!.entryCount).toBe("number");
    });

    it("searches by email", async () => {
      const ctx = createAdminContext();
      const caller = createCaller(ctx);

      await createTestUser("findme-unique");
      await createTestUser("other-user");

      const result = await caller.admin.listUsers({ search: "findme-unique" });

      expect(result.items).toHaveLength(1);
      expect(result.items[0].email).toContain("findme-unique");
    });

    it("pagination works", async () => {
      const ctx = createAdminContext();
      const caller = createCaller(ctx);

      // Create enough users to paginate
      await createTestUser("page-a");
      await createTestUser("page-b");
      await createTestUser("page-c");

      const page1 = await caller.admin.listUsers({ limit: 2 });

      expect(page1.items).toHaveLength(2);
      expect(page1.nextCursor).toBeDefined();

      const page2 = await caller.admin.listUsers({
        limit: 2,
        cursor: page1.nextCursor,
      });

      expect(page2.items.length).toBeGreaterThanOrEqual(1);

      // Verify no overlap between pages
      const page1Ids = new Set(page1.items.map((u) => u.id));
      for (const user of page2.items) {
        expect(page1Ids.has(user.id)).toBe(false);
      }
    });
  });
});

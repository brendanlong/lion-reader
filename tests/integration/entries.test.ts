/**
 * Integration tests for entries endpoints.
 *
 * These tests verify entry operations: list, get, search, markRead, star/unstar.
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/server/db";
import { users, feeds, entries, subscriptions, userEntries } from "../../src/server/db/schema";
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
        groqApiKey: null,
        anthropicApiKey: null,
        summarizationModel: null,
        summarizationMaxWords: null,
        summarizationPrompt: null,
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

/**
 * Creates a test feed.
 */
async function createTestFeed(url: string, title: string = "Test Feed"): Promise<string> {
  const feedId = generateUuidv7();
  const now = new Date();
  await db.insert(feeds).values({
    id: feedId,
    type: "web",
    url,
    title,
    lastFetchedAt: now,
    lastEntriesUpdatedAt: now,
    createdAt: now,
    updatedAt: now,
  });
  return feedId;
}

/**
 * Creates a test subscription.
 */
async function createTestSubscription(userId: string, feedId: string): Promise<string> {
  const subscriptionId = generateUuidv7();
  await db.insert(subscriptions).values({
    id: subscriptionId,
    userId,
    feedId,
    subscribedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return subscriptionId;
}

/**
 * Creates a test entry.
 */
async function createTestEntry(
  feedId: string,
  options: {
    guid?: string;
    title?: string;
    contentCleaned?: string;
    publishedAt?: Date;
  } = {}
): Promise<string> {
  const entryId = generateUuidv7();
  const now = new Date();
  const guid = options.guid ?? `guid-${entryId}`;

  await db.insert(entries).values({
    id: entryId,
    feedId,
    type: "web",
    guid,
    title: options.title ?? `Entry ${entryId}`,
    contentCleaned: options.contentCleaned ?? `Content for ${options.title ?? entryId}`,
    contentHash: `hash-${entryId}`,
    fetchedAt: options.publishedAt ?? now,
    publishedAt: options.publishedAt ?? now,
    lastSeenAt: now,
    createdAt: now,
    updatedAt: now,
  });

  return entryId;
}

/**
 * Creates a user_entries row.
 */
async function createUserEntry(
  userId: string,
  entryId: string,
  options: {
    read?: boolean;
    starred?: boolean;
    readChangedAt?: Date;
    starredChangedAt?: Date;
  } = {}
): Promise<void> {
  const now = new Date();
  await db.insert(userEntries).values({
    userId,
    entryId,
    read: options.read ?? false,
    starred: options.starred ?? false,
    readChangedAt: options.readChangedAt ?? now,
    starredChangedAt: options.starredChangedAt ?? now,
    updatedAt: now,
  });
}

// ============================================================================
// Tests
// ============================================================================

describe("Entries", () => {
  beforeEach(async () => {
    await db.delete(userEntries);
    await db.delete(entries);
    await db.delete(subscriptions);
    await db.delete(feeds);
    await db.delete(users);
  });

  afterAll(async () => {
    await db.delete(userEntries);
    await db.delete(entries);
    await db.delete(subscriptions);
    await db.delete(feeds);
    await db.delete(users);
  });

  describe("list", () => {
    it("lists entries for a user's subscription", async () => {
      const userId = await createTestUser();
      const feedId = await createTestFeed("https://example.com/feed.xml");
      await createTestSubscription(userId, feedId);

      const entry1Id = await createTestEntry(feedId, { title: "Entry 1" });
      const entry2Id = await createTestEntry(feedId, { title: "Entry 2" });

      await createUserEntry(userId, entry1Id);
      await createUserEntry(userId, entry2Id);

      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);

      const result = await caller.entries.list({});

      expect(result.items).toHaveLength(2);
      expect(result.items.map((e) => e.id)).toContain(entry1Id);
      expect(result.items.map((e) => e.id)).toContain(entry2Id);
    });

    it("filters by unreadOnly", async () => {
      const userId = await createTestUser();
      const feedId = await createTestFeed("https://example.com/feed.xml");
      await createTestSubscription(userId, feedId);

      const unreadId = await createTestEntry(feedId, { title: "Unread Entry" });
      const readId = await createTestEntry(feedId, { title: "Read Entry" });

      await createUserEntry(userId, unreadId, { read: false });
      await createUserEntry(userId, readId, { read: true });

      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);

      const result = await caller.entries.list({ unreadOnly: true });

      expect(result.items).toHaveLength(1);
      expect(result.items[0].id).toBe(unreadId);
      expect(result.items[0].read).toBe(false);
    });

    it("filters by starredOnly", async () => {
      const userId = await createTestUser();
      const feedId = await createTestFeed("https://example.com/feed.xml");
      await createTestSubscription(userId, feedId);

      const starredId = await createTestEntry(feedId, { title: "Starred Entry" });
      const unstarredId = await createTestEntry(feedId, { title: "Unstarred Entry" });

      await createUserEntry(userId, starredId, { starred: true });
      await createUserEntry(userId, unstarredId, { starred: false });

      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);

      const result = await caller.entries.list({ starredOnly: true });

      expect(result.items).toHaveLength(1);
      expect(result.items[0].id).toBe(starredId);
      expect(result.items[0].starred).toBe(true);
    });
  });

  describe("get", () => {
    it("gets a single entry with full content", async () => {
      const userId = await createTestUser();
      const feedId = await createTestFeed("https://example.com/feed.xml");
      await createTestSubscription(userId, feedId);

      const entryId = await createTestEntry(feedId, {
        title: "Test Entry",
        contentCleaned: "<p>This is test content</p>",
      });
      await createUserEntry(userId, entryId);

      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);

      const result = await caller.entries.get({ id: entryId });

      expect(result.entry.id).toBe(entryId);
      expect(result.entry.title).toBe("Test Entry");
      expect(result.entry.contentCleaned).toBe("<p>This is test content</p>");
    });

    it("throws error for entry that doesn't exist", async () => {
      const userId = await createTestUser();
      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);

      const nonExistentId = generateUuidv7();
      await expect(caller.entries.get({ id: nonExistentId })).rejects.toThrow();
    });

    it("throws error for entry user doesn't have access to", async () => {
      const user1Id = await createTestUser("user1");
      const user2Id = await createTestUser("user2");
      const feedId = await createTestFeed("https://example.com/feed.xml");
      await createTestSubscription(user1Id, feedId);

      const entryId = await createTestEntry(feedId, { title: "User 1 Entry" });
      await createUserEntry(user1Id, entryId);

      // User 2 tries to access User 1's entry
      const ctx2 = createAuthContext(user2Id);
      const caller2 = createCaller(ctx2);

      await expect(caller2.entries.get({ id: entryId })).rejects.toThrow();
    });
  });

  describe("list with query", () => {
    it("searches entries by title", async () => {
      const userId = await createTestUser();
      const feedId = await createTestFeed("https://example.com/feed.xml");
      await createTestSubscription(userId, feedId);

      const entry1Id = await createTestEntry(feedId, {
        title: "PostgreSQL Full-Text Search",
        contentCleaned: "Some content about databases",
      });
      const entry2Id = await createTestEntry(feedId, {
        title: "MySQL Query Optimization",
        contentCleaned: "Some content about queries",
      });
      const entry3Id = await createTestEntry(feedId, {
        title: "MongoDB Aggregations",
        contentCleaned: "Some content about NoSQL",
      });

      await createUserEntry(userId, entry1Id);
      await createUserEntry(userId, entry2Id);
      await createUserEntry(userId, entry3Id);

      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);

      const result = await caller.entries.list({ query: "PostgreSQL" });

      expect(result.items).toHaveLength(1);
      expect(result.items[0].id).toBe(entry1Id);
      expect(result.items[0].title).toBe("PostgreSQL Full-Text Search");
    });

    it("searches entries by content", async () => {
      const userId = await createTestUser();
      const feedId = await createTestFeed("https://example.com/feed.xml");
      await createTestSubscription(userId, feedId);

      const entry1Id = await createTestEntry(feedId, {
        title: "Article 1",
        contentCleaned: "This article discusses artificial intelligence and machine learning",
      });
      const entry2Id = await createTestEntry(feedId, {
        title: "Article 2",
        contentCleaned: "This article is about database indexing strategies",
      });

      await createUserEntry(userId, entry1Id);
      await createUserEntry(userId, entry2Id);

      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);

      const result = await caller.entries.list({
        query: "artificial intelligence",
      });

      expect(result.items).toHaveLength(1);
      expect(result.items[0].id).toBe(entry1Id);
    });

    it("searches entries by both title and content (default)", async () => {
      const userId = await createTestUser();
      const feedId = await createTestFeed("https://example.com/feed.xml");
      await createTestSubscription(userId, feedId);

      const entry1Id = await createTestEntry(feedId, {
        title: "TypeScript Guide",
        contentCleaned: "Learn about static typing",
      });
      const entry2Id = await createTestEntry(feedId, {
        title: "JavaScript Basics",
        contentCleaned: "Introduction to TypeScript features",
      });
      const entry3Id = await createTestEntry(feedId, {
        title: "Python Tutorial",
        contentCleaned: "Learn Python programming",
      });

      await createUserEntry(userId, entry1Id);
      await createUserEntry(userId, entry2Id);
      await createUserEntry(userId, entry3Id);

      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);

      // Should match both entry1 (title) and entry2 (content)
      const result = await caller.entries.list({ query: "TypeScript" });

      expect(result.items).toHaveLength(2);
      expect(result.items.map((e) => e.id)).toContain(entry1Id);
      expect(result.items.map((e) => e.id)).toContain(entry2Id);
    });

    it("combines search with unreadOnly filter", async () => {
      const userId = await createTestUser();
      const feedId = await createTestFeed("https://example.com/feed.xml");
      await createTestSubscription(userId, feedId);

      const unreadMatch = await createTestEntry(feedId, {
        title: "Unread React Article",
        contentCleaned: "About React hooks",
      });
      const readMatch = await createTestEntry(feedId, {
        title: "Read React Article",
        contentCleaned: "About React context",
      });

      await createUserEntry(userId, unreadMatch, { read: false });
      await createUserEntry(userId, readMatch, { read: true });

      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);

      const result = await caller.entries.list({ query: "React", unreadOnly: true });

      expect(result.items).toHaveLength(1);
      expect(result.items[0].id).toBe(unreadMatch);
      expect(result.items[0].read).toBe(false);
    });

    it("returns empty results for non-matching query", async () => {
      const userId = await createTestUser();
      const feedId = await createTestFeed("https://example.com/feed.xml");
      await createTestSubscription(userId, feedId);

      await createTestEntry(feedId, { title: "JavaScript Basics" });
      await createUserEntry(userId, await createTestEntry(feedId, { title: "Python Tutorial" }));

      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);

      const result = await caller.entries.list({ query: "nonexistentquery12345" });

      expect(result.items).toHaveLength(0);
    });
  });

  describe("markRead", () => {
    it("marks entries as read", async () => {
      const userId = await createTestUser();
      const feedId = await createTestFeed("https://example.com/feed.xml");
      await createTestSubscription(userId, feedId);

      const entry1Id = await createTestEntry(feedId, { title: "Entry 1" });
      const entry2Id = await createTestEntry(feedId, { title: "Entry 2" });

      await createUserEntry(userId, entry1Id, { read: false });
      await createUserEntry(userId, entry2Id, { read: false });

      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);

      const result = await caller.entries.markRead({
        entries: [{ id: entry1Id }, { id: entry2Id }],
        read: true,
      });

      expect(result.success).toBe(true);
      expect(result.count).toBe(2);

      // Verify database state
      const dbEntries = await db.select().from(userEntries).where(eq(userEntries.userId, userId));

      expect(dbEntries.every((e) => e.read === true)).toBe(true);
    });

    it("marks entries as unread", async () => {
      const userId = await createTestUser();
      const feedId = await createTestFeed("https://example.com/feed.xml");
      await createTestSubscription(userId, feedId);

      const entryId = await createTestEntry(feedId, { title: "Read Entry" });
      await createUserEntry(userId, entryId, { read: true });

      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);

      const result = await caller.entries.markRead({ entries: [{ id: entryId }], read: false });

      expect(result.success).toBe(true);
      expect(result.count).toBe(1);

      // Verify database state
      const dbEntry = await db
        .select()
        .from(userEntries)
        .where(eq(userEntries.entryId, entryId))
        .limit(1);

      expect(dbEntry[0].read).toBe(false);
    });

    it("marks multiple entries with success response", async () => {
      const userId = await createTestUser();
      const feedId = await createTestFeed("https://example.com/feed.xml");
      await createTestSubscription(userId, feedId);

      const entry1Id = await createTestEntry(feedId, { title: "Entry 1" });
      const entry2Id = await createTestEntry(feedId, { title: "Entry 2" });
      const entry3Id = await createTestEntry(feedId, { title: "Entry 3" });

      await createUserEntry(userId, entry1Id, { read: false });
      await createUserEntry(userId, entry2Id, { read: false });
      await createUserEntry(userId, entry3Id, { read: false });

      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);

      // Mark 2 as read
      const result = await caller.entries.markRead({
        entries: [{ id: entry1Id }, { id: entry2Id }],
        read: true,
      });

      expect(result.success).toBe(true);
      expect(result.count).toBe(2);

      // Verify database state - 2 read, 1 unread
      const dbEntries = await db.select().from(userEntries).where(eq(userEntries.userId, userId));

      const readCount = dbEntries.filter((e) => e.read).length;
      const unreadCount = dbEntries.filter((e) => !e.read).length;

      expect(readCount).toBe(2);
      expect(unreadCount).toBe(1);
    });
  });

  describe("star/unstar", () => {
    it("stars an entry", async () => {
      const userId = await createTestUser();
      const feedId = await createTestFeed("https://example.com/feed.xml");
      await createTestSubscription(userId, feedId);

      const entryId = await createTestEntry(feedId, { title: "Entry to star" });
      await createUserEntry(userId, entryId, { starred: false });

      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);

      const result = await caller.entries.setStarred({ id: entryId, starred: true });

      expect(result.entry.id).toBe(entryId);
      expect(result.entry.starred).toBe(true);

      // Verify database state
      const dbEntry = await db
        .select()
        .from(userEntries)
        .where(eq(userEntries.entryId, entryId))
        .limit(1);

      expect(dbEntry[0].starred).toBe(true);
    });

    it("unstars an entry", async () => {
      const userId = await createTestUser();
      const feedId = await createTestFeed("https://example.com/feed.xml");
      await createTestSubscription(userId, feedId);

      const entryId = await createTestEntry(feedId, { title: "Starred entry" });
      await createUserEntry(userId, entryId, { starred: true });

      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);

      const result = await caller.entries.setStarred({ id: entryId, starred: false });

      expect(result.entry.id).toBe(entryId);
      expect(result.entry.starred).toBe(false);

      // Verify database state
      const dbEntry = await db
        .select()
        .from(userEntries)
        .where(eq(userEntries.entryId, entryId))
        .limit(1);

      expect(dbEntry[0].starred).toBe(false);
    });

    it("throws error when starring entry user doesn't have access to", async () => {
      const user1Id = await createTestUser("user1");
      const user2Id = await createTestUser("user2");
      const feedId = await createTestFeed("https://example.com/feed.xml");
      await createTestSubscription(user1Id, feedId);

      const entryId = await createTestEntry(feedId, { title: "User 1 Entry" });
      await createUserEntry(user1Id, entryId);

      // User 2 tries to star User 1's entry
      const ctx2 = createAuthContext(user2Id);
      const caller2 = createCaller(ctx2);

      await expect(caller2.entries.setStarred({ id: entryId, starred: true })).rejects.toThrow();
    });
  });

  describe("count", () => {
    it("counts total and unread entries", async () => {
      const userId = await createTestUser();
      const feedId = await createTestFeed("https://example.com/feed.xml");
      await createTestSubscription(userId, feedId);

      const entry1Id = await createTestEntry(feedId, { title: "Entry 1" });
      const entry2Id = await createTestEntry(feedId, { title: "Entry 2" });
      const entry3Id = await createTestEntry(feedId, { title: "Entry 3" });

      await createUserEntry(userId, entry1Id, { read: false });
      await createUserEntry(userId, entry2Id, { read: false });
      await createUserEntry(userId, entry3Id, { read: true });

      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);

      const result = await caller.entries.count({});

      expect(result.total).toBe(3);
      expect(result.unread).toBe(2);
    });

    it("counts with filters", async () => {
      const userId = await createTestUser();
      const feedId = await createTestFeed("https://example.com/feed.xml");
      await createTestSubscription(userId, feedId);

      const unread1Id = await createTestEntry(feedId, { title: "Unread 1" });
      const unread2Id = await createTestEntry(feedId, { title: "Unread 2" });
      const readId = await createTestEntry(feedId, { title: "Read" });

      await createUserEntry(userId, unread1Id, { read: false });
      await createUserEntry(userId, unread2Id, { read: false });
      await createUserEntry(userId, readId, { read: true });

      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);

      const result = await caller.entries.count({ unreadOnly: true });

      expect(result.total).toBe(2);
      expect(result.unread).toBe(2);
    });
  });

  describe("idempotency", () => {
    it("applies update when changedAt is newer than stored timestamp", async () => {
      const userId = await createTestUser();
      const feedId = await createTestFeed("https://example.com/feed.xml");
      await createTestSubscription(userId, feedId);

      const oldTimestamp = new Date("2024-01-01T00:00:00Z");
      const newTimestamp = new Date("2024-01-02T00:00:00Z");

      const entryId = await createTestEntry(feedId, { title: "Entry" });
      await createUserEntry(userId, entryId, { read: false, readChangedAt: oldTimestamp });

      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);

      // Update with newer timestamp should succeed
      const result = await caller.entries.markRead({
        entries: [{ id: entryId, changedAt: newTimestamp }],
        read: true,
      });

      expect(result.success).toBe(true);

      // Verify database state
      const dbEntry = await db
        .select()
        .from(userEntries)
        .where(eq(userEntries.entryId, entryId))
        .limit(1);

      expect(dbEntry[0].read).toBe(true);
      expect(dbEntry[0].readChangedAt?.toISOString()).toBe(newTimestamp.toISOString());
    });

    it("rejects update when changedAt is older than stored timestamp", async () => {
      const userId = await createTestUser();
      const feedId = await createTestFeed("https://example.com/feed.xml");
      await createTestSubscription(userId, feedId);

      const newerTimestamp = new Date("2024-01-02T00:00:00Z");
      const olderTimestamp = new Date("2024-01-01T00:00:00Z");

      const entryId = await createTestEntry(feedId, { title: "Entry" });
      await createUserEntry(userId, entryId, { read: true, readChangedAt: newerTimestamp });

      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);

      // Update with older timestamp should be rejected (no-op)
      await caller.entries.markRead({
        entries: [{ id: entryId, changedAt: olderTimestamp }],
        read: false,
      });

      // Verify database state is unchanged
      const dbEntry = await db
        .select()
        .from(userEntries)
        .where(eq(userEntries.entryId, entryId))
        .limit(1);

      expect(dbEntry[0].read).toBe(true); // Still true, not changed to false
      expect(dbEntry[0].readChangedAt?.toISOString()).toBe(newerTimestamp.toISOString());
    });

    it("same timestamp update succeeds (last-write-wins)", async () => {
      const userId = await createTestUser();
      const feedId = await createTestFeed("https://example.com/feed.xml");
      await createTestSubscription(userId, feedId);

      const timestamp = new Date("2024-01-01T00:00:00Z");

      const entryId = await createTestEntry(feedId, { title: "Entry" });
      await createUserEntry(userId, entryId, { read: true, readChangedAt: timestamp });

      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);

      // Same timestamp, different value - should succeed with >= comparison
      await caller.entries.markRead({
        entries: [{ id: entryId, changedAt: timestamp }],
        read: false,
      });

      // Verify database state is updated
      const dbEntry = await db
        .select()
        .from(userEntries)
        .where(eq(userEntries.entryId, entryId))
        .limit(1);

      expect(dbEntry[0].read).toBe(false); // Updated
    });

    it("changing read state does not affect starred timestamp", async () => {
      const userId = await createTestUser();
      const feedId = await createTestFeed("https://example.com/feed.xml");
      await createTestSubscription(userId, feedId);

      const initialTimestamp = new Date("2024-01-01T00:00:00Z");
      const newTimestamp = new Date("2024-01-02T00:00:00Z");

      const entryId = await createTestEntry(feedId, { title: "Entry" });
      await createUserEntry(userId, entryId, {
        read: false,
        starred: true,
        readChangedAt: initialTimestamp,
        starredChangedAt: initialTimestamp,
      });

      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);

      // Update read state
      await caller.entries.markRead({
        entries: [{ id: entryId, changedAt: newTimestamp }],
        read: true,
      });

      // Verify starred timestamp is unchanged
      const dbEntry = await db
        .select()
        .from(userEntries)
        .where(eq(userEntries.entryId, entryId))
        .limit(1);

      expect(dbEntry[0].read).toBe(true);
      expect(dbEntry[0].readChangedAt?.toISOString()).toBe(newTimestamp.toISOString());
      expect(dbEntry[0].starred).toBe(true);
      expect(dbEntry[0].starredChangedAt?.toISOString()).toBe(initialTimestamp.toISOString());
    });

    it("bulk update returns final state for all entries even when some are skipped", async () => {
      const userId = await createTestUser();
      const feedId = await createTestFeed("https://example.com/feed.xml");
      await createTestSubscription(userId, feedId);

      const oldTimestamp = new Date("2024-01-01T00:00:00Z");
      const newerTimestamp = new Date("2024-01-02T00:00:00Z");
      const requestTimestamp = new Date("2024-01-01T12:00:00Z"); // Between old and newer

      const entry1Id = await createTestEntry(feedId, { title: "Entry 1" });
      const entry2Id = await createTestEntry(feedId, { title: "Entry 2" });

      // Entry 1 has old timestamp - should be updated
      await createUserEntry(userId, entry1Id, { read: false, readChangedAt: oldTimestamp });
      // Entry 2 has newer timestamp - should NOT be updated
      await createUserEntry(userId, entry2Id, { read: true, readChangedAt: newerTimestamp });

      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);

      const result = await caller.entries.markRead({
        entries: [
          { id: entry1Id, changedAt: requestTimestamp },
          { id: entry2Id, changedAt: requestTimestamp },
        ],
        read: true,
      });

      // Should return final state for both entries
      expect(result.entries).toHaveLength(2);
      expect(result.entries.find((e) => e.id === entry1Id)).toBeDefined();
      expect(result.entries.find((e) => e.id === entry2Id)).toBeDefined();

      // Verify database state
      const dbEntries = await db.select().from(userEntries).where(eq(userEntries.userId, userId));

      const entry1 = dbEntries.find((e) => e.entryId === entry1Id);
      const entry2 = dbEntries.find((e) => e.entryId === entry2Id);

      expect(entry1?.read).toBe(true); // Updated
      expect(entry1?.readChangedAt?.toISOString()).toBe(requestTimestamp.toISOString());
      expect(entry2?.read).toBe(true); // Unchanged (was already true)
      expect(entry2?.readChangedAt?.toISOString()).toBe(newerTimestamp.toISOString()); // Timestamp not changed
    });

    it("star idempotency - newer timestamp wins", async () => {
      const userId = await createTestUser();
      const feedId = await createTestFeed("https://example.com/feed.xml");
      await createTestSubscription(userId, feedId);

      const oldTimestamp = new Date("2024-01-01T00:00:00Z");
      const newTimestamp = new Date("2024-01-02T00:00:00Z");

      const entryId = await createTestEntry(feedId, { title: "Entry" });
      await createUserEntry(userId, entryId, { starred: false, starredChangedAt: oldTimestamp });

      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);

      // Star with newer timestamp should succeed
      const result = await caller.entries.setStarred({
        id: entryId,
        starred: true,
        changedAt: newTimestamp,
      });

      expect(result.entry.starred).toBe(true);

      // Verify database state
      const dbEntry = await db
        .select()
        .from(userEntries)
        .where(eq(userEntries.entryId, entryId))
        .limit(1);

      expect(dbEntry[0].starred).toBe(true);
      expect(dbEntry[0].starredChangedAt?.toISOString()).toBe(newTimestamp.toISOString());
    });

    it("star idempotency - older timestamp rejected", async () => {
      const userId = await createTestUser();
      const feedId = await createTestFeed("https://example.com/feed.xml");
      await createTestSubscription(userId, feedId);

      const newerTimestamp = new Date("2024-01-02T00:00:00Z");
      const olderTimestamp = new Date("2024-01-01T00:00:00Z");

      const entryId = await createTestEntry(feedId, { title: "Entry" });
      await createUserEntry(userId, entryId, { starred: true, starredChangedAt: newerTimestamp });

      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);

      // Unstar with older timestamp should be rejected
      const result = await caller.entries.setStarred({
        id: entryId,
        starred: false,
        changedAt: olderTimestamp,
      });

      // Returns final state (still starred)
      expect(result.entry.starred).toBe(true);

      // Verify database state is unchanged
      const dbEntry = await db
        .select()
        .from(userEntries)
        .where(eq(userEntries.entryId, entryId))
        .limit(1);

      expect(dbEntry[0].starred).toBe(true);
      expect(dbEntry[0].starredChangedAt?.toISOString()).toBe(newerTimestamp.toISOString());
    });
  });
});

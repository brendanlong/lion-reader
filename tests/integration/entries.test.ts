/**
 * Integration tests for entries endpoints.
 *
 * These tests verify entry operations: list, get, search, markRead, star/unstar.
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { eq, and, inArray } from "drizzle-orm";
import { db } from "../../src/server/db";
import {
  users,
  feeds,
  entries,
  subscriptions,
  subscriptionFeeds,
  subscriptionTags,
  tags,
  userEntries,
} from "../../src/server/db/schema";
import { generateUuidv7 } from "../../src/lib/uuidv7";
import { createCaller } from "../../src/server/trpc/root";
import type { Context } from "../../src/server/trpc/context";
import {
  markAllEntriesRead,
  markEntriesRead,
  listEntries,
} from "../../src/server/services/entries";

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
        scopes: null,
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
        tosAgreedAt: new Date(),
        privacyPolicyAgreedAt: new Date(),
        notEuAgreedAt: new Date(),
        passwordHash: "test-hash",
        inviteId: null,
        showSpam: false,
        lastActiveAt: null,
        groqApiKey: null,
        anthropicApiKey: null,
        summarizationModel: null,
        summarizationMaxWords: null,
        summarizationPrompt: null,
        createdAt: now,
        updatedAt: now,
      },
      hasGroqApiKey: false,
      hasAnthropicApiKey: false,
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
  await db
    .insert(subscriptionFeeds)
    .values({ subscriptionId, feedId, userId })
    .onConflictDoNothing();
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
    isSpam?: boolean;
    type?: "web" | "email" | "saved";
  } = {}
): Promise<string> {
  const entryId = generateUuidv7();
  const now = new Date();
  const guid = options.guid ?? `guid-${entryId}`;
  // is_spam is only permitted on email entries (entries_spam_only_email);
  // last_seen_at is only permitted on fetched/web entries
  // (entries_last_seen_only_fetched).
  const type = options.type ?? (options.isSpam ? "email" : "web");

  await db.insert(entries).values({
    id: entryId,
    feedId,
    type,
    guid,
    title: options.title ?? `Entry ${entryId}`,
    contentCleaned: options.contentCleaned ?? `Content for ${options.title ?? entryId}`,
    contentHash: `hash-${entryId}`,
    fetchedAt: options.publishedAt ?? now,
    publishedAt: options.publishedAt ?? now,
    lastSeenAt: type === "web" ? now : null,
    isSpam: options.isSpam ?? false,
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

    it("hides orphaned entries (user_entries row with no subscription) unless starred", async () => {
      const userId = await createTestUser();
      const feedId = await createTestFeed("https://example.com/feed.xml");
      // No subscription is created: these user_entries rows are orphaned.
      // Fail-closed visibility (migration 0073) requires a matching active
      // subscription OR starred, so only the starred entry is visible.
      const orphanedId = await createTestEntry(feedId, { title: "Orphaned" });
      const orphanedStarredId = await createTestEntry(feedId, { title: "Orphaned Starred" });

      await createUserEntry(userId, orphanedId);
      await createUserEntry(userId, orphanedStarredId, { starred: true });

      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);

      const result = await caller.entries.list({});

      expect(result.items.map((e) => e.id)).toEqual([orphanedStarredId]);
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

  describe("list deduplicates entries reachable through overlapping subscriptions", () => {
    /**
     * Regression for #1083. visible_entries emits one row per matching
     * subscription_feeds row, so an entry reachable through overlapping
     * subscriptions (from feed redirect/merge history) would appear multiple
     * times in the list/search — even across cursor pages — and disagree with
     * the count paths that dedupe via count(DISTINCT id).
     *
     * Fixture: sub1 covers feedA and feedB (redirect/merge history in
     * subscription_feeds), sub2 covers feedB directly. An entry in feedB is thus
     * reachable through both subscriptions and must still appear exactly once.
     */
    async function createOverlappingSubscriptions(
      userId: string,
      entryOptions: Parameters<typeof createTestEntry>[1] = {}
    ) {
      const feedIdA = await createTestFeed("https://feed-a.com/rss", "Feed A");
      const feedIdB = await createTestFeed("https://feed-b.com/rss", "Feed B");
      const subId1 = await createTestSubscription(userId, feedIdA);
      const subId2 = await createTestSubscription(userId, feedIdB);
      // sub1 also covers feedB (redirect/merge history) — overlapping with sub2.
      await db
        .insert(subscriptionFeeds)
        .values({ subscriptionId: subId1, feedId: feedIdB, userId });

      const entryIdA = await createTestEntry(feedIdA, { title: "Only In A" });
      const entryIdB = await createTestEntry(feedIdB, entryOptions);
      await createUserEntry(userId, entryIdA);
      await createUserEntry(userId, entryIdB);

      return { feedIdA, feedIdB, subId1, subId2, entryIdA, entryIdB };
    }

    it("returns a single row per entry in the timeline", async () => {
      const userId = await createTestUser();
      const { entryIdA, entryIdB } = await createOverlappingSubscriptions(userId);

      const result = await listEntries(db, { userId, showSpam: false });

      const ids = result.items.map((e) => e.id);
      expect(ids).toHaveLength(2);
      expect(ids).toContain(entryIdA);
      expect(ids.filter((id) => id === entryIdB)).toHaveLength(1);
    });

    it("returns each entry once when paging through the cursor", async () => {
      const userId = await createTestUser();
      const { entryIdA, entryIdB } = await createOverlappingSubscriptions(userId);

      const seen: string[] = [];
      let cursor: string | undefined;
      // Documents keyset cross-page safety: the duplicate rows share an identical
      // (ts, id) cursor key, so DISTINCT ON collapses them within a page and the
      // `< cursor` predicate never re-surfaces the survivor on a later page. Walk
      // every row at page size 1 to confirm each entry appears exactly once.
      for (let i = 0; i < 5; i++) {
        const page = await listEntries(db, { userId, limit: 1, cursor, showSpam: false });
        seen.push(...page.items.map((e) => e.id));
        cursor = page.nextCursor;
        if (!cursor) break;
      }

      expect(seen.sort()).toEqual([entryIdA, entryIdB].sort());
    });

    it("returns a single row per entry in search results", async () => {
      const userId = await createTestUser();
      const { entryIdB } = await createOverlappingSubscriptions(userId, {
        title: "Distributed Systems Consensus",
        contentCleaned: "Content about the Raft algorithm",
      });

      const result = await listEntries(db, {
        userId,
        query: "Distributed Systems",
        showSpam: false,
      });

      const ids = result.items.map((e) => e.id);
      expect(ids).toEqual([entryIdB]);
    });
  });

  describe("list with offset", () => {
    it("skips `offset` rows in one query (page/offset pagination for compat APIs)", async () => {
      const userId = await createTestUser();
      const feedId = await createTestFeed("https://example.com/feed.xml");
      await createTestSubscription(userId, feedId);

      // Three entries with distinct publish times so the newest-first order is
      // deterministic: newest → oldest is [c, b, a].
      const aId = await createTestEntry(feedId, {
        title: "A",
        publishedAt: new Date("2026-01-01T00:00:00Z"),
      });
      const bId = await createTestEntry(feedId, {
        title: "B",
        publishedAt: new Date("2026-01-02T00:00:00Z"),
      });
      const cId = await createTestEntry(feedId, {
        title: "C",
        publishedAt: new Date("2026-01-03T00:00:00Z"),
      });
      for (const id of [aId, bId, cId]) await createUserEntry(userId, id);

      // Page size 1: offset 0/1/2 return c/b/a respectively, matching what the
      // old cursor-skip loop produced but in a single indexed query per page.
      const page1 = await listEntries(db, { userId, limit: 1, offset: 0, showSpam: false });
      const page2 = await listEntries(db, { userId, limit: 1, offset: 1, showSpam: false });
      const page3 = await listEntries(db, { userId, limit: 1, offset: 2, showSpam: false });
      const page4 = await listEntries(db, { userId, limit: 1, offset: 3, showSpam: false });

      expect(page1.items.map((e) => e.id)).toEqual([cId]);
      expect(page2.items.map((e) => e.id)).toEqual([bId]);
      expect(page3.items.map((e) => e.id)).toEqual([aId]);
      // Offset past the end yields an empty page (not an error).
      expect(page4.items).toHaveLength(0);
    });
  });

  describe("list with updatedAfter (Wallabag `since` delta sync)", () => {
    it("returns entries whose state OR content changed since the checkpoint", async () => {
      const userId = await createTestUser();
      const feedId = await createTestFeed("https://example.com/feed.xml");
      await createTestSubscription(userId, feedId);

      // Three entries, all "modified" long ago (both entry.updated_at and
      // user_entries.updated_at pinned to the same old time).
      const stateChangedId = await createTestEntry(feedId, { title: "State" });
      const contentChangedId = await createTestEntry(feedId, { title: "Content" });
      const untouchedId = await createTestEntry(feedId, { title: "Untouched" });
      for (const id of [stateChangedId, contentChangedId, untouchedId]) {
        await createUserEntry(userId, id);
      }

      const past = new Date("2026-01-01T00:00:00Z");
      const allIds = [stateChangedId, contentChangedId, untouchedId];
      await db.update(entries).set({ updatedAt: past }).where(inArray(entries.id, allIds));
      await db
        .update(userEntries)
        .set({ updatedAt: past })
        .where(and(eq(userEntries.userId, userId), inArray(userEntries.entryId, allIds)));

      // Client's last sync happened after `past`; nothing has changed since, so a
      // delta sync returns nothing.
      const checkpoint = new Date("2026-01-02T00:00:00Z");
      const before = await listEntries(db, { userId, updatedAfter: checkpoint, showSpam: false });
      expect(before.items).toHaveLength(0);

      // A read-state change bumps user_entries.updated_at (a Wallabag archive), and
      // a content refetch bumps entries.updated_at — both must surface via the
      // GREATEST(entry.updated_at, user_entries.updated_at) that updatedAfter filters.
      await markEntriesRead(db, userId, [{ id: stateChangedId }], true);
      await db
        .update(entries)
        .set({ updatedAt: new Date() })
        .where(eq(entries.id, contentChangedId));

      const after = await listEntries(db, { userId, updatedAfter: checkpoint, showSpam: false });
      expect(after.items.map((e) => e.id).sort()).toEqual(
        [stateChangedId, contentChangedId].sort()
      );
      // The untouched entry stays out of the delta.
      expect(after.items.map((e) => e.id)).not.toContain(untouchedId);
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

      expect(result.unread).toBe(2);
    });

    it("does not double-count entries reachable through overlapping subscriptions", async () => {
      // visible_entries emits one row per matching subscription_feeds row, so an
      // entry reachable through two subscriptions to the same feed (redirect/
      // merge history) appears twice. The unread count must dedupe by entry id
      // so the sidebar badge stays consistent with the counts service.
      const userId = await createTestUser();
      const feedA = await createTestFeed("https://a.com/rss");
      const feedB = await createTestFeed("https://b.com/rss");
      const subId1 = await createTestSubscription(userId, feedA);
      await createTestSubscription(userId, feedB);
      // Extra subscription_feeds row: sub1 also covers feedB (merge history).
      await db
        .insert(subscriptionFeeds)
        .values({ subscriptionId: subId1, feedId: feedB, userId })
        .onConflictDoNothing();

      const entryA = await createTestEntry(feedA, { title: "A" });
      const entryB = await createTestEntry(feedB, { title: "B" });
      await createUserEntry(userId, entryA, { read: false });
      await createUserEntry(userId, entryB, { read: false }); // reachable via sub1 AND sub2

      const caller = createCaller(createAuthContext(userId));
      const result = await caller.entries.count({});

      // Two distinct unread entries, not three.
      expect(result.unread).toBe(2);
    });
  });

  describe("markAllEntriesRead service", () => {
    it("scopes the tag filter to the caller's own tags", async () => {
      // The service is the documented reuse layer, so tag ownership must be
      // enforced here, not just by router pre-validation (issue #956).
      const victimId = await createTestUser("victim");
      const attackerId = await createTestUser("attacker");

      const feedId = await createTestFeed("https://victim-feed.com/rss");
      const subscriptionId = await createTestSubscription(victimId, feedId);
      const entryId = await createTestEntry(feedId, { title: "Victim entry" });
      await createUserEntry(victimId, entryId, { read: false });

      // The victim's tag on the victim's subscription
      const tagId = generateUuidv7();
      await db.insert(tags).values({ id: tagId, userId: victimId, name: "Victim tag" });
      await db.insert(subscriptionTags).values({ tagId, subscriptionId });

      // The attacker subscribes to the same shared feed with their own unread
      // entry, then passes the victim's tagId. Another user's tag must not
      // resolve to any feeds for them.
      await createTestSubscription(attackerId, feedId);
      await createUserEntry(attackerId, entryId, { read: false });

      const marked = await markAllEntriesRead(db, { userId: attackerId, tagId, showSpam: false });
      expect(marked).toEqual([]);

      const attackerEntries = await db
        .select({ read: userEntries.read })
        .from(userEntries)
        .where(eq(userEntries.userId, attackerId));
      expect(attackerEntries).toEqual([{ read: false }]);

      // The owner can still mark through their tag
      const ownMarked = await markAllEntriesRead(db, { userId: victimId, tagId, showSpam: false });
      expect(ownMarked).toEqual([entryId]);
    });

    it("excludes hidden spam entries unless showSpam is set", async () => {
      // "Mark all read" must only touch entries the user can actually see, like
      // listEntries/countEntries — otherwise hidden spam would be marked read and
      // surface as already-read if the user later enables showSpam (issue #1089).
      const userId = await createTestUser();
      const feedId = await createTestFeed("https://spam-feed.com/rss");
      await createTestSubscription(userId, feedId);

      const normalId = await createTestEntry(feedId, { title: "Normal" });
      const spamId = await createTestEntry(feedId, { title: "Spam", isSpam: true });
      await createUserEntry(userId, normalId, { read: false });
      await createUserEntry(userId, spamId, { read: false });

      // With spam hidden, only the non-spam entry is marked.
      const marked = await markAllEntriesRead(db, { userId, showSpam: false });
      expect(marked).toEqual([normalId]);

      const spamState = await db
        .select({ read: userEntries.read })
        .from(userEntries)
        .where(and(eq(userEntries.userId, userId), eq(userEntries.entryId, spamId)));
      expect(spamState).toEqual([{ read: false }]);

      // With showSpam, the spam entry is marked too.
      const markedWithSpam = await markAllEntriesRead(db, { userId, showSpam: true });
      expect(markedWithSpam).toEqual([spamId]);
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

    it("re-marking read bumps timestamp to protect against late-arriving offline unread", async () => {
      // Scenario:
      // 1. Mark read at time 1
      // 2. Mark unread at time 2 (offline, queued)
      // 3. Mark read at time 3 (online)
      // 4. Event from (2) arrives with changedAt=time2
      // Final state should be read, because time3 > time2
      const userId = await createTestUser();
      const feedId = await createTestFeed("https://example.com/feed.xml");
      await createTestSubscription(userId, feedId);

      const time0 = new Date("2024-01-01T00:00:00Z");
      const time1 = new Date("2024-01-02T00:00:00Z");
      const time2 = new Date("2024-01-03T00:00:00Z");
      const time3 = new Date("2024-01-04T00:00:00Z");

      const entryId = await createTestEntry(feedId, { title: "Entry" });
      await createUserEntry(userId, entryId, { read: false, readChangedAt: time0 });

      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);

      // Step 1: Mark read at time 1
      await caller.entries.markRead({
        entries: [{ id: entryId, changedAt: time1 }],
        read: true,
      });

      // Step 3: Mark read again at time 3 (skipping offline step 2)
      await caller.entries.markRead({
        entries: [{ id: entryId, changedAt: time3 }],
        read: true,
      });

      // Verify readChangedAt was bumped to time3
      const dbEntryBefore = await db
        .select()
        .from(userEntries)
        .where(eq(userEntries.entryId, entryId))
        .limit(1);

      expect(dbEntryBefore[0].read).toBe(true);
      expect(dbEntryBefore[0].readChangedAt?.toISOString()).toBe(time3.toISOString());

      // Step 4: Late-arriving offline event from step 2 (mark unread at time 2)
      await caller.entries.markRead({
        entries: [{ id: entryId, changedAt: time2 }],
        read: false,
      });

      // Final state should still be read with time3 timestamp
      const dbEntryAfter = await db
        .select()
        .from(userEntries)
        .where(eq(userEntries.entryId, entryId))
        .limit(1);

      expect(dbEntryAfter[0].read).toBe(true);
      expect(dbEntryAfter[0].readChangedAt?.toISOString()).toBe(time3.toISOString());
    });

    it("re-starring bumps timestamp to protect against late-arriving offline unstar", async () => {
      // Same scenario as above but for starred state
      const userId = await createTestUser();
      const feedId = await createTestFeed("https://example.com/feed.xml");
      await createTestSubscription(userId, feedId);

      const time0 = new Date("2024-01-01T00:00:00Z");
      const time1 = new Date("2024-01-02T00:00:00Z");
      const time2 = new Date("2024-01-03T00:00:00Z");
      const time3 = new Date("2024-01-04T00:00:00Z");

      const entryId = await createTestEntry(feedId, { title: "Entry" });
      await createUserEntry(userId, entryId, { starred: false, starredChangedAt: time0 });

      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);

      // Step 1: Star at time 1
      await caller.entries.setStarred({
        id: entryId,
        starred: true,
        changedAt: time1,
      });

      // Step 3: Star again at time 3
      await caller.entries.setStarred({
        id: entryId,
        starred: true,
        changedAt: time3,
      });

      // Verify starredChangedAt was bumped to time3
      const dbEntryBefore = await db
        .select()
        .from(userEntries)
        .where(eq(userEntries.entryId, entryId))
        .limit(1);

      expect(dbEntryBefore[0].starred).toBe(true);
      expect(dbEntryBefore[0].starredChangedAt?.toISOString()).toBe(time3.toISOString());

      // Step 4: Late-arriving offline event from step 2 (unstar at time 2)
      await caller.entries.setStarred({
        id: entryId,
        starred: false,
        changedAt: time2,
      });

      // Final state should still be starred with time3 timestamp
      const dbEntryAfter = await db
        .select()
        .from(userEntries)
        .where(eq(userEntries.entryId, entryId))
        .limit(1);

      expect(dbEntryAfter[0].starred).toBe(true);
      expect(dbEntryAfter[0].starredChangedAt?.toISOString()).toBe(time3.toISOString());
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

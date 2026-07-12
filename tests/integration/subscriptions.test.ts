/**
 * Integration tests for feed subscriptions.
 *
 * These tests verify the subscribe-to-existing feed logic, ensuring that
 * users see only current entries (based on lastSeenAt) and don't see older
 * entries from previous fetches.
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/server/db";
import { users, feeds, entries, subscriptions, userEntries } from "../../src/server/db/schema";
import { generateUuidv7 } from "../../src/lib/uuidv7";
import { createCaller } from "../../src/server/trpc/root";
import type { Context } from "../../src/server/trpc/context";
import * as subscriptionsService from "../../src/server/services/subscriptions";

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
 * Creates a test feed with specified timestamps.
 */
async function createTestFeed(options: {
  url: string;
  title?: string;
  lastFetchedAt?: Date | null;
  lastEntriesUpdatedAt?: Date | null;
}): Promise<string> {
  const feedId = generateUuidv7();
  const now = new Date();
  await db.insert(feeds).values({
    id: feedId,
    type: "web",
    url: options.url,
    title: options.title ?? `Test Feed ${feedId}`,
    lastFetchedAt: options.lastFetchedAt ?? null,
    lastEntriesUpdatedAt: options.lastEntriesUpdatedAt ?? null,
    createdAt: now,
    updatedAt: now,
  });
  return feedId;
}

/**
 * Creates a test subscription for a user and feed.
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
 * Creates a test entry with specified timestamps.
 */
async function createTestEntry(
  feedId: string,
  options: {
    guid?: string;
    title?: string;
    fetchedAt?: Date;
    lastSeenAt?: Date | null;
  } = {}
): Promise<string> {
  const entryId = generateUuidv7();
  const now = options.fetchedAt ?? new Date();
  const guid = options.guid ?? `guid-${entryId}`;

  await db.insert(entries).values({
    id: entryId,
    feedId,
    type: "web",
    guid,
    title: options.title ?? `Entry ${entryId}`,
    contentHash: `hash-${entryId}`,
    fetchedAt: now,
    lastSeenAt: options.lastSeenAt ?? now,
    createdAt: now,
    updatedAt: now,
  });

  return entryId;
}

/**
 * Gets user_entries count for a user.
 */
async function getUserEntriesCount(userId: string): Promise<number> {
  const result = await db.select().from(userEntries).where(eq(userEntries.userId, userId));
  return result.length;
}

/**
 * Gets specific user_entries for a user.
 */
async function getUserEntries(userId: string): Promise<Array<{ entryId: string }>> {
  const result = await db
    .select({ entryId: userEntries.entryId })
    .from(userEntries)
    .where(eq(userEntries.userId, userId));
  return result;
}

// ============================================================================
// Tests
// ============================================================================

describe("Subscriptions - Subscribe to Existing Feed", () => {
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

  describe("Entry visibility based on lastSeenAt", () => {
    it("shows only current entries when subscribing to existing feed", async () => {
      // User A subscribes to a feed
      const userAId = await createTestUser("userA");

      // Create a feed that has been fetched
      const feedUrl = "https://example.com/feed.xml";
      const fetch1Time = new Date("2024-01-01T10:00:00Z");
      const fetch2Time = new Date("2024-01-02T10:00:00Z");

      const feedId = await createTestFeed({
        url: feedUrl,
        lastFetchedAt: fetch2Time,
        lastEntriesUpdatedAt: fetch2Time,
      });

      // First fetch had entries 1 and 2
      const entry1Id = await createTestEntry(feedId, {
        guid: "entry-1",
        title: "Old Entry 1",
        fetchedAt: fetch1Time,
        lastSeenAt: fetch1Time, // Old timestamp
      });

      const entry2Id = await createTestEntry(feedId, {
        guid: "entry-2",
        title: "Old Entry 2",
        fetchedAt: fetch1Time,
        lastSeenAt: fetch1Time, // Old timestamp
      });

      // Second fetch has entries 2, 3, and 4 (entry 1 disappeared, 3 and 4 are new)
      // Entry 2 is updated to current fetch time
      await db.update(entries).set({ lastSeenAt: fetch2Time }).where(eq(entries.id, entry2Id));

      const entry3Id = await createTestEntry(feedId, {
        guid: "entry-3",
        title: "Current Entry 3",
        fetchedAt: fetch2Time,
        lastSeenAt: fetch2Time, // Current timestamp
      });

      const entry4Id = await createTestEntry(feedId, {
        guid: "entry-4",
        title: "Current Entry 4",
        fetchedAt: fetch2Time,
        lastSeenAt: fetch2Time, // Current timestamp
      });

      // User A already subscribed
      await createTestSubscription(userAId, feedId);

      // User B subscribes to the same feed
      const userBId = await createTestUser("userB");
      const ctxB = createAuthContext(userBId);
      const callerB = createCaller(ctxB);

      const result = await callerB.subscriptions.create({ url: feedUrl });

      expect(result.url).toBe(feedUrl);
      expect(result.unreadCount).toBe(3);

      // Verify User B has user_entries for only the current entries (2, 3, 4)
      const userBEntries = await getUserEntries(userBId);
      const userBEntryIds = userBEntries.map((e) => e.entryId).sort();

      expect(userBEntryIds).toHaveLength(3);
      expect(userBEntryIds).toContain(entry2Id);
      expect(userBEntryIds).toContain(entry3Id);
      expect(userBEntryIds).toContain(entry4Id);
      expect(userBEntryIds).not.toContain(entry1Id); // Old entry should not be visible
    });

    it("shows all entries when lastEntriesUpdatedAt matches all entries lastSeenAt", async () => {
      const userId = await createTestUser();

      const feedUrl = "https://example.com/feed2.xml";
      const fetchTime = new Date("2024-01-01T10:00:00Z");

      const feedId = await createTestFeed({
        url: feedUrl,
        lastFetchedAt: fetchTime,
        lastEntriesUpdatedAt: fetchTime,
      });

      // All entries have the same lastSeenAt
      const entry1Id = await createTestEntry(feedId, {
        guid: "entry-1",
        title: "Entry 1",
        fetchedAt: fetchTime,
        lastSeenAt: fetchTime,
      });

      const entry2Id = await createTestEntry(feedId, {
        guid: "entry-2",
        title: "Entry 2",
        fetchedAt: fetchTime,
        lastSeenAt: fetchTime,
      });

      const entry3Id = await createTestEntry(feedId, {
        guid: "entry-3",
        title: "Entry 3",
        fetchedAt: fetchTime,
        lastSeenAt: fetchTime,
      });

      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);

      const result = await caller.subscriptions.create({ url: feedUrl });

      expect(result.unreadCount).toBe(3);

      // Verify all entries are visible
      const entries = await getUserEntries(userId);
      const entryIds = entries.map((e) => e.entryId).sort();

      expect(entryIds).toHaveLength(3);
      expect(entryIds).toContain(entry1Id);
      expect(entryIds).toContain(entry2Id);
      expect(entryIds).toContain(entry3Id);
    });

    it("handles multiple fetches correctly - shows only entries from last fetch with changes", async () => {
      const userId = await createTestUser();

      const feedUrl = "https://example.com/feed3.xml";
      const fetch1Time = new Date("2024-01-01T10:00:00Z");
      const fetch2Time = new Date("2024-01-02T10:00:00Z");
      const fetch3Time = new Date("2024-01-03T10:00:00Z");

      const feedId = await createTestFeed({
        url: feedUrl,
        lastFetchedAt: fetch3Time,
        lastEntriesUpdatedAt: fetch3Time,
      });

      // Fetch 1: entries A, B
      await createTestEntry(feedId, {
        guid: "entry-A",
        title: "Entry A",
        fetchedAt: fetch1Time,
        lastSeenAt: fetch1Time,
      });

      await createTestEntry(feedId, {
        guid: "entry-B",
        title: "Entry B",
        fetchedAt: fetch1Time,
        lastSeenAt: fetch1Time,
      });

      // Fetch 2: entries B, C (A disappeared, C is new)
      const entryBId = (
        await db
          .select({ id: entries.id })
          .from(entries)
          .where(eq(entries.guid, "entry-B"))
          .limit(1)
      )[0].id;

      await db.update(entries).set({ lastSeenAt: fetch2Time }).where(eq(entries.id, entryBId));

      await createTestEntry(feedId, {
        guid: "entry-C",
        title: "Entry C",
        fetchedAt: fetch2Time,
        lastSeenAt: fetch2Time,
      });

      // Fetch 3: entries C, D, E (B disappeared, D and E are new)
      const entryCId = (
        await db
          .select({ id: entries.id })
          .from(entries)
          .where(eq(entries.guid, "entry-C"))
          .limit(1)
      )[0].id;

      await db.update(entries).set({ lastSeenAt: fetch3Time }).where(eq(entries.id, entryCId));

      const entryDId = await createTestEntry(feedId, {
        guid: "entry-D",
        title: "Entry D",
        fetchedAt: fetch3Time,
        lastSeenAt: fetch3Time,
      });

      const entryEId = await createTestEntry(feedId, {
        guid: "entry-E",
        title: "Entry E",
        fetchedAt: fetch3Time,
        lastSeenAt: fetch3Time,
      });

      // User subscribes after all 3 fetches
      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);

      const result = await caller.subscriptions.create({ url: feedUrl });

      expect(result.unreadCount).toBe(3);

      // Should only see C, D, E (entries from fetch 3)
      const userEntriesResult = await getUserEntries(userId);
      const entryIds = userEntriesResult.map((e) => e.entryId).sort();

      expect(entryIds).toHaveLength(3);
      expect(entryIds).toContain(entryCId);
      expect(entryIds).toContain(entryDId);
      expect(entryIds).toContain(entryEId);
    });
  });

  describe("Edge cases", () => {
    it("handles feed with no lastEntriesUpdatedAt (never had entry changes)", async () => {
      const userId = await createTestUser();

      const feedUrl = "https://example.com/feed-no-changes.xml";
      const feedId = await createTestFeed({
        url: feedUrl,
        lastFetchedAt: new Date("2024-01-01T10:00:00Z"),
        lastEntriesUpdatedAt: null, // Never had entry changes
      });

      // Create some entries (shouldn't be visible since lastEntriesUpdatedAt is null)
      await createTestEntry(feedId, {
        guid: "entry-1",
        title: "Entry 1",
      });

      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);

      const result = await caller.subscriptions.create({ url: feedUrl });

      expect(result.unreadCount).toBe(0);

      // Verify no user_entries created
      const count = await getUserEntriesCount(userId);
      expect(count).toBe(0);
    });

    it("handles empty feed (no entries)", async () => {
      const userId = await createTestUser();

      const feedUrl = "https://example.com/empty-feed.xml";
      await createTestFeed({
        url: feedUrl,
        lastFetchedAt: new Date("2024-01-01T10:00:00Z"),
        lastEntriesUpdatedAt: new Date("2024-01-01T10:00:00Z"),
      });

      // No entries created

      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);

      const result = await caller.subscriptions.create({ url: feedUrl });

      expect(result.unreadCount).toBe(0);

      // Verify no user_entries created
      const count = await getUserEntriesCount(userId);
      expect(count).toBe(0);
    });

    it("handles resubscribing after unsubscribing", async () => {
      const userId = await createTestUser();

      const feedUrl = "https://example.com/resubscribe.xml";
      const fetchTime = new Date("2024-01-01T10:00:00Z");

      const feedId = await createTestFeed({
        url: feedUrl,
        lastFetchedAt: fetchTime,
        lastEntriesUpdatedAt: fetchTime,
      });

      await createTestEntry(feedId, {
        guid: "entry-1",
        title: "Entry 1",
        fetchedAt: fetchTime,
        lastSeenAt: fetchTime,
      });

      await createTestEntry(feedId, {
        guid: "entry-2",
        title: "Entry 2",
        fetchedAt: fetchTime,
        lastSeenAt: fetchTime,
      });

      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);

      // First subscription
      const result1 = await caller.subscriptions.create({ url: feedUrl });
      const subscriptionId = result1.id;

      expect(result1.unreadCount).toBe(2);

      // Verify user_entries exist
      let userEntriesResult = await getUserEntries(userId);
      expect(userEntriesResult).toHaveLength(2);

      // Unsubscribe
      await caller.subscriptions.delete({ id: subscriptionId });

      // Verify subscription is soft-deleted
      const unsubscribed = await db
        .select()
        .from(subscriptions)
        .where(eq(subscriptions.id, subscriptionId))
        .limit(1);
      expect(unsubscribed[0].unsubscribedAt).not.toBeNull();

      // Resubscribe
      const result2 = await caller.subscriptions.create({ url: feedUrl });

      // Should reactivate the same subscription
      expect(result2.id).toBe(subscriptionId);
      expect(result2.unreadCount).toBe(2);

      // Verify subscription is reactivated
      const reactivated = await db
        .select()
        .from(subscriptions)
        .where(eq(subscriptions.id, subscriptionId))
        .limit(1);
      expect(reactivated[0].unsubscribedAt).toBeNull();

      // Verify user_entries are populated again
      userEntriesResult = await getUserEntries(userId);
      expect(userEntriesResult).toHaveLength(2);
    });

    it("handles feed with no fetches yet (lastFetchedAt is null)", async () => {
      const userId = await createTestUser();

      const feedUrl = "https://example.com/never-fetched.xml";
      await createTestFeed({
        url: feedUrl,
        lastFetchedAt: null,
        lastEntriesUpdatedAt: null,
      });

      // This scenario would normally trigger the "slow path" in the router
      // but for this test we're verifying the database state
      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);

      // Note: This will actually trigger a network fetch in the real implementation,
      // but for this test we're just verifying that when lastFetchedAt is null,
      // the fast path is not taken. The subscriptions.create will fail because
      // we can't actually fetch the URL in tests, but that's okay - we're testing
      // the condition check.
      await expect(caller.subscriptions.create({ url: feedUrl })).rejects.toThrow();
    });

    it("handles feed where all entries have disappeared (no current entries)", async () => {
      const userId = await createTestUser();

      const feedUrl = "https://example.com/all-disappeared.xml";
      const fetch1Time = new Date("2024-01-01T10:00:00Z");
      const fetch2Time = new Date("2024-01-02T10:00:00Z");

      const feedId = await createTestFeed({
        url: feedUrl,
        lastFetchedAt: fetch2Time,
        lastEntriesUpdatedAt: fetch2Time,
      });

      // First fetch had entries
      await createTestEntry(feedId, {
        guid: "entry-1",
        title: "Old Entry 1",
        fetchedAt: fetch1Time,
        lastSeenAt: fetch1Time,
      });

      await createTestEntry(feedId, {
        guid: "entry-2",
        title: "Old Entry 2",
        fetchedAt: fetch1Time,
        lastSeenAt: fetch1Time,
      });

      // Second fetch had no entries (all disappeared)
      // lastEntriesUpdatedAt is fetch2Time but no entries have that lastSeenAt

      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);

      const result = await caller.subscriptions.create({ url: feedUrl });

      expect(result.unreadCount).toBe(0);

      // Verify no user_entries created
      const count = await getUserEntriesCount(userId);
      expect(count).toBe(0);
    });
  });

  describe("Idempotent subscribe", () => {
    it("returns existing subscription when subscribing twice", async () => {
      const userId = await createTestUser();

      const feedUrl = "https://example.com/idempotent.xml";
      const fetchTime = new Date("2024-01-01T10:00:00Z");

      const feedId = await createTestFeed({
        url: feedUrl,
        lastFetchedAt: fetchTime,
        lastEntriesUpdatedAt: fetchTime,
      });

      await createTestEntry(feedId, {
        guid: "entry-1",
        fetchedAt: fetchTime,
        lastSeenAt: fetchTime,
      });

      await createTestEntry(feedId, {
        guid: "entry-2",
        fetchedAt: fetchTime,
        lastSeenAt: fetchTime,
      });

      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);

      // First subscribe
      const result1 = await caller.subscriptions.create({ url: feedUrl });
      expect(result1.unreadCount).toBe(2);

      // Second subscribe — should return same subscription, not error
      const result2 = await caller.subscriptions.create({ url: feedUrl });
      expect(result2.id).toBe(result1.id);
      expect(result2.unreadCount).toBe(2);
      expect(result2.subscribedAt).toEqual(result1.subscribedAt);

      // Should not duplicate user_entries
      const entriesResult = await getUserEntries(userId);
      expect(entriesResult).toHaveLength(2);
    });
  });

  describe("Reactivation preserves settings", () => {
    it("preserves custom title and fetchFullContent after resubscribe", async () => {
      const userId = await createTestUser();

      const feedUrl = "https://example.com/reactivate-settings.xml";
      const fetchTime = new Date("2024-01-01T10:00:00Z");

      const feedId = await createTestFeed({
        url: feedUrl,
        title: "Original Title",
        lastFetchedAt: fetchTime,
        lastEntriesUpdatedAt: fetchTime,
      });

      await createTestEntry(feedId, {
        guid: "entry-1",
        fetchedAt: fetchTime,
        lastSeenAt: fetchTime,
      });

      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);

      // Subscribe
      const result1 = await caller.subscriptions.create({ url: feedUrl });
      const subscriptionId = result1.id;

      // Set custom title and fetchFullContent
      await db
        .update(subscriptions)
        .set({ customTitle: "My Custom Title", fetchFullContent: true })
        .where(eq(subscriptions.id, subscriptionId));

      // Unsubscribe
      await caller.subscriptions.delete({ id: subscriptionId });

      // Resubscribe
      const result2 = await caller.subscriptions.create({ url: feedUrl });

      // Should reactivate same subscription with preserved settings
      expect(result2.id).toBe(subscriptionId);
      expect(result2.title).toBe("My Custom Title");
      expect(result2.fetchFullContent).toBe(true);
      expect(result2.originalTitle).toBe("Original Title");
    });
  });

  describe("Absolute counts on create/delete", () => {
    async function seedFeedWithUnread(url: string, count: number): Promise<string> {
      const fetchTime = new Date("2024-01-01T10:00:00Z");
      const feedId = await createTestFeed({
        url,
        lastFetchedAt: fetchTime,
        lastEntriesUpdatedAt: fetchTime,
      });
      for (let i = 0; i < count; i++) {
        await createTestEntry(feedId, {
          guid: `${url}-${i}`,
          fetchedAt: fetchTime,
          lastSeenAt: fetchTime,
        });
      }
      return feedId;
    }

    it("create returns absolute counts for the new untagged subscription", async () => {
      const userId = await createTestUser();
      await seedFeedWithUnread("https://example.com/counts-a.xml", 3);
      const caller = createCaller(createAuthContext(userId));

      const result = await caller.subscriptions.create({ url: "https://example.com/counts-a.xml" });

      expect(result.counts?.all.unread).toBe(3);
      expect(result.counts?.uncategorized?.unread).toBe(3);
      expect(result.counts?.subscriptions).toContainEqual({ id: result.id, unread: 3 });
      expect(result.counts?.tags).toEqual([]);
    });

    it("delete returns absolute counts reflecting the removal (uncategorized)", async () => {
      const userId = await createTestUser();
      await seedFeedWithUnread("https://example.com/counts-b.xml", 3);
      const caller = createCaller(createAuthContext(userId));
      const sub = await caller.subscriptions.create({ url: "https://example.com/counts-b.xml" });

      const result = await caller.subscriptions.delete({ id: sub.id });

      expect(result.success).toBe(true);
      expect(result.counts?.all.unread).toBe(0);
      expect(result.counts?.uncategorized?.unread).toBe(0);
    });

    it("delete returns the former tag's post-removal absolute count", async () => {
      const userId = await createTestUser();
      await seedFeedWithUnread("https://example.com/counts-c.xml", 2);
      await seedFeedWithUnread("https://example.com/counts-d.xml", 3);
      const caller = createCaller(createAuthContext(userId));
      const subC = await caller.subscriptions.create({ url: "https://example.com/counts-c.xml" });
      const subD = await caller.subscriptions.create({ url: "https://example.com/counts-d.xml" });

      // Tag both subscriptions so the tag's unread is 2 + 3 = 5.
      const { tag } = await caller.tags.create({ name: "News" });
      await caller.subscriptions.setTags({ id: subC.id, tagIds: [tag.id] });
      await caller.subscriptions.setTags({ id: subD.id, tagIds: [tag.id] });

      // Deleting subC (2 unread) leaves the tag with subD's 3 unread.
      const result = await caller.subscriptions.delete({ id: subC.id });

      expect(result.counts?.tags).toContainEqual({ id: tag.id, unread: 3 });
      expect(result.counts?.uncategorized).toBeUndefined();
      expect(result.counts?.all.unread).toBe(3);
    });
  });

  describe("Multiple users subscribing", () => {
    it("each user gets their own user_entries for current entries", async () => {
      const userAId = await createTestUser("userA");
      const userBId = await createTestUser("userB");
      const userCId = await createTestUser("userC");

      const feedUrl = "https://example.com/multi-user.xml";
      const fetchTime = new Date("2024-01-01T10:00:00Z");

      const feedId = await createTestFeed({
        url: feedUrl,
        lastFetchedAt: fetchTime,
        lastEntriesUpdatedAt: fetchTime,
      });

      const entry1Id = await createTestEntry(feedId, {
        guid: "entry-1",
        title: "Entry 1",
        fetchedAt: fetchTime,
        lastSeenAt: fetchTime,
      });

      const entry2Id = await createTestEntry(feedId, {
        guid: "entry-2",
        title: "Entry 2",
        fetchedAt: fetchTime,
        lastSeenAt: fetchTime,
      });

      // All three users subscribe
      const ctxA = createAuthContext(userAId);
      const callerA = createCaller(ctxA);
      await callerA.subscriptions.create({ url: feedUrl });

      const ctxB = createAuthContext(userBId);
      const callerB = createCaller(ctxB);
      await callerB.subscriptions.create({ url: feedUrl });

      const ctxC = createAuthContext(userCId);
      const callerC = createCaller(ctxC);
      await callerC.subscriptions.create({ url: feedUrl });

      // Verify each user has their own user_entries
      const userAEntries = await getUserEntries(userAId);
      const userBEntries = await getUserEntries(userBId);
      const userCEntries = await getUserEntries(userCId);

      expect(userAEntries).toHaveLength(2);
      expect(userBEntries).toHaveLength(2);
      expect(userCEntries).toHaveLength(2);

      // All should have the same entry IDs
      expect(userAEntries.map((e) => e.entryId).sort()).toEqual([entry1Id, entry2Id].sort());
      expect(userBEntries.map((e) => e.entryId).sort()).toEqual([entry1Id, entry2Id].sort());
      expect(userCEntries.map((e) => e.entryId).sort()).toEqual([entry1Id, entry2Id].sort());
    });
  });

  describe("list with query filter", () => {
    it("filters subscriptions by title query", async () => {
      const userId = await createTestUser();

      // Create multiple feeds
      const feed1Id = await createTestFeed({
        url: "https://example.com/tech.xml",
        title: "Tech Blog",
      });
      const feed2Id = await createTestFeed({
        url: "https://example.com/science.xml",
        title: "Science Daily",
      });
      const feed3Id = await createTestFeed({
        url: "https://example.com/cooking.xml",
        title: "Cooking Tips",
      });

      // Subscribe to all
      await createTestSubscription(userId, feed1Id);
      await createTestSubscription(userId, feed2Id);
      await createTestSubscription(userId, feed3Id);

      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);

      // Search for "Tech"
      const result = await caller.subscriptions.list({ query: "Tech" });

      expect(result.items).toHaveLength(1);
      expect(result.items[0].title).toBe("Tech Blog");
    });

    it("filters subscriptions with custom titles", async () => {
      const userId = await createTestUser();

      const feedId = await createTestFeed({
        url: "https://example.com/feed.xml",
        title: "Original Title",
      });
      const subscriptionId = await createTestSubscription(userId, feedId);

      // Update to custom title
      await db
        .update(subscriptions)
        .set({ customTitle: "My Custom Feed Name" })
        .where(eq(subscriptions.id, subscriptionId));

      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);

      // Query should match custom title
      const result = await caller.subscriptions.list({ query: "Custom" });

      expect(result.items).toHaveLength(1);
      expect(result.items[0].title).toBe("My Custom Feed Name");
    });

    it("returns multiple matching subscriptions ranked by relevance", async () => {
      const userId = await createTestUser();

      const feed1Id = await createTestFeed({
        url: "https://example.com/js1.xml",
        title: "JavaScript Weekly",
      });
      const feed2Id = await createTestFeed({
        url: "https://example.com/js2.xml",
        title: "JavaScript Daily News",
      });
      const feed3Id = await createTestFeed({
        url: "https://example.com/py.xml",
        title: "Python Tutorial",
      });

      await createTestSubscription(userId, feed1Id);
      await createTestSubscription(userId, feed2Id);
      await createTestSubscription(userId, feed3Id);

      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);

      const result = await caller.subscriptions.list({ query: "JavaScript" });

      expect(result.items).toHaveLength(2);
      expect(result.items.map((s) => s.title)).toContain("JavaScript Weekly");
      expect(result.items.map((s) => s.title)).toContain("JavaScript Daily News");
    });

    it("returns empty results for non-matching query", async () => {
      const userId = await createTestUser();

      const feedId = await createTestFeed({
        url: "https://example.com/tech.xml",
        title: "Tech News",
      });
      await createTestSubscription(userId, feedId);

      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);

      const result = await caller.subscriptions.list({ query: "nonexistentquery12345" });

      expect(result.items).toHaveLength(0);
    });

    it("only filters user's own subscriptions", async () => {
      const user1Id = await createTestUser("user1");
      const user2Id = await createTestUser("user2");

      const feed1Id = await createTestFeed({
        url: "https://example.com/feed1.xml",
        title: "Shared Topic Feed",
      });
      const feed2Id = await createTestFeed({
        url: "https://example.com/feed2.xml",
        title: "Another Topic Feed",
      });

      // User 1 subscribes to feed 1
      await createTestSubscription(user1Id, feed1Id);
      // User 2 subscribes to feed 2
      await createTestSubscription(user2Id, feed2Id);

      // User 1 searches for "Topic"
      const ctx1 = createAuthContext(user1Id);
      const caller1 = createCaller(ctx1);
      const result1 = await caller1.subscriptions.list({ query: "Topic" });

      // Should only see their own subscription
      expect(result1.items).toHaveLength(1);
      expect(result1.items[0].title).toBe("Shared Topic Feed");
    });

    it("filters case-insensitively (lowercase query matches mixed case title)", async () => {
      const userId = await createTestUser();

      const feedId = await createTestFeed({
        url: "https://example.com/arxiv.xml",
        title: "cs.AI updates on arXiv.org",
      });
      await createTestSubscription(userId, feedId);

      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);

      // Search with lowercase - should match
      const result = await caller.subscriptions.list({ query: "arxiv" });

      expect(result.items).toHaveLength(1);
      expect(result.items[0].title).toBe("cs.AI updates on arXiv.org");
    });

    it("filters case-insensitively (uppercase query matches mixed case title)", async () => {
      const userId = await createTestUser();

      const feedId = await createTestFeed({
        url: "https://example.com/arxiv.xml",
        title: "cs.AI updates on arXiv.org",
      });
      await createTestSubscription(userId, feedId);

      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);

      // Search with uppercase - should match
      const result = await caller.subscriptions.list({ query: "ARXIV" });

      expect(result.items).toHaveLength(1);
      expect(result.items[0].title).toBe("cs.AI updates on arXiv.org");
    });

    it("filters case-insensitively (mixed case query matches different case title)", async () => {
      const userId = await createTestUser();

      const feedId = await createTestFeed({
        url: "https://example.com/feed.xml",
        title: "JavaScript Weekly Newsletter",
      });
      await createTestSubscription(userId, feedId);

      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);

      // Search with different casing
      const result1 = await caller.subscriptions.list({ query: "javascript" });
      expect(result1.items).toHaveLength(1);

      const result2 = await caller.subscriptions.list({ query: "WEEKLY" });
      expect(result2.items).toHaveLength(1);

      const result3 = await caller.subscriptions.list({ query: "newsletter" });
      expect(result3.items).toHaveLength(1);

      // All should find the same feed
      expect(result1.items[0].id).toBe(result2.items[0].id);
      expect(result2.items[0].id).toBe(result3.items[0].id);
    });

    it("filters case-insensitively with partial matches", async () => {
      const userId = await createTestUser();

      const feed1Id = await createTestFeed({
        url: "https://example.com/python.xml",
        title: "Python Tutorial Blog",
      });
      const feed2Id = await createTestFeed({
        url: "https://example.com/ruby.xml",
        title: "Ruby Programming Tips",
      });

      await createTestSubscription(userId, feed1Id);
      await createTestSubscription(userId, feed2Id);

      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);

      // Search for partial substring with different casing
      const result = await caller.subscriptions.list({ query: "PROG" });

      expect(result.items).toHaveLength(1);
      expect(result.items[0].title).toBe("Ruby Programming Tips");
    });
  });
});

describe("listAllSubscriptions", () => {
  it("returns every subscription in one call, past the 100-per-page cap", async () => {
    const userId = await createTestUser();

    // More than listSubscriptions' hard cap of 100 so a single unbounded query is
    // observably different from a capped one. Bulk-insert for speed.
    const N = 101;
    const feedRows = Array.from({ length: N }, (_, i) => ({
      id: generateUuidv7(),
      type: "web" as const,
      url: `https://example.com/all-subs/${i}.xml`,
      title: `Feed ${String(i).padStart(3, "0")}`,
      createdAt: new Date(),
      updatedAt: new Date(),
    }));
    await db.insert(feeds).values(feedRows);
    await db.insert(subscriptions).values(
      feedRows.map((f) => ({
        id: generateUuidv7(),
        userId,
        feedId: f.id,
        subscribedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      }))
    );

    const all = await subscriptionsService.listAllSubscriptions(db, userId);

    expect(all).toHaveLength(N);
    // Ordered alphabetically by title, matching listSubscriptions.
    const titles = all.map((s) => s.title);
    expect(titles).toEqual([...titles].sort());
  });

  it("matches listSubscriptions' rows and shape for a user's subscriptions", async () => {
    const userId = await createTestUser();
    const feedA = await createTestFeed({ url: "https://example.com/a.xml", title: "Alpha" });
    const feedB = await createTestFeed({ url: "https://example.com/b.xml", title: "Beta" });
    await createTestSubscription(userId, feedA);
    await createTestSubscription(userId, feedB);

    const all = await subscriptionsService.listAllSubscriptions(db, userId);
    const paged = await subscriptionsService.listSubscriptions(db, { userId, limit: 100 });

    // Same rows (ids), no pagination cursor semantics to worry about.
    expect(all.map((s) => s.id).sort()).toEqual(paged.subscriptions.map((s) => s.id).sort());
    // Same object shape as the paginated variant (id/title/unreadCount/tags present).
    const alpha = all.find((s) => s.title === "Alpha");
    expect(alpha).toMatchObject({ title: "Alpha", unreadCount: 0, tags: [] });
  });

  it("returns an empty array for a user with no subscriptions", async () => {
    const userId = await createTestUser();
    const all = await subscriptionsService.listAllSubscriptions(db, userId);
    expect(all).toEqual([]);
  });
});

describe("includeUnreadCounts: false (issue #1074)", () => {
  /**
   * A user with one subscription and one unread visible entry, so the default
   * query provably counts it (unreadCount 1) and the opt-out is observable
   * (unreadCount 0) rather than vacuously matching an empty backlog.
   */
  async function createUserWithUnreadEntry(): Promise<{ userId: string; subId: string }> {
    const userId = await createTestUser();
    const feedId = await createTestFeed({
      url: `https://example.com/unread-${userId}.xml`,
      title: "Counted Feed",
    });
    const subId = await createTestSubscription(userId, feedId);
    const entryId = await createTestEntry(feedId);
    await db.insert(userEntries).values({ userId, entryId });
    return { userId, subId };
  }

  it("listAllSubscriptions returns the same rows with unreadCount pinned to 0", async () => {
    const { userId } = await createUserWithUnreadEntry();

    const withCounts = await subscriptionsService.listAllSubscriptions(db, userId);
    const withoutCounts = await subscriptionsService.listAllSubscriptions(db, userId, {
      includeUnreadCounts: false,
    });

    // Sanity: the default query actually counts the unread entry.
    expect(withCounts).toHaveLength(1);
    expect(withCounts[0].unreadCount).toBe(1);

    // Identical rows apart from the skipped count.
    expect(withoutCounts).toEqual([{ ...withCounts[0], unreadCount: 0 }]);
  });

  it("getSubscription returns the same row with unreadCount pinned to 0", async () => {
    const { userId, subId } = await createUserWithUnreadEntry();

    const withCounts = await subscriptionsService.getSubscription(db, userId, subId);
    const withoutCounts = await subscriptionsService.getSubscription(db, userId, subId, {
      includeUnreadCounts: false,
    });

    expect(withCounts.unreadCount).toBe(1);
    expect(withoutCounts).toEqual({ ...withCounts, unreadCount: 0 });
  });
});

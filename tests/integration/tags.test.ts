/**
 * Integration tests for the Tags API.
 *
 * These tests use a real database to verify tag CRUD operations
 * and the proper handling of user isolation and authorization.
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { eq, and, isNull } from "drizzle-orm";
import { db } from "../../src/server/db";
import {
  users,
  tags,
  subscriptions,
  subscriptionFeeds,
  subscriptionTags,
  feeds,
  entries,
  userEntries,
} from "../../src/server/db/schema";
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
 * Creates a test feed and returns its ID.
 */
async function createTestFeed(url: string): Promise<string> {
  const feedId = generateUuidv7();
  await db.insert(feeds).values({
    id: feedId,
    type: "web",
    url,
    title: `Test Feed ${feedId}`,
    createdAt: new Date(),
    updatedAt: new Date(),
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
  await db
    .insert(subscriptionFeeds)
    .values({ subscriptionId, feedId, userId })
    .onConflictDoNothing();
  return subscriptionId;
}

/**
 * Links a tag to a subscription.
 */
async function linkTagToSubscription(tagId: string, subscriptionId: string): Promise<void> {
  await db.insert(subscriptionTags).values({
    tagId,
    subscriptionId,
    createdAt: new Date(),
  });
}

/**
 * Creates a test entry for a feed and optionally creates user_entries for visibility.
 */
async function createTestEntry(
  feedId: string,
  options: { fetchedAt?: Date; title?: string; userIds?: string[] } = {}
): Promise<string> {
  const entryId = generateUuidv7();
  const now = options.fetchedAt ?? new Date();
  await db.insert(entries).values({
    id: entryId,
    feedId,
    type: "web",
    guid: `guid-${entryId}`,
    title: options.title ?? `Entry ${entryId}`,
    contentHash: `hash-${entryId}`,
    fetchedAt: now,
    lastSeenAt: now, // Required for web entries
    createdAt: now,
    updatedAt: now,
  });

  // Create user_entries for visibility
  if (options.userIds && options.userIds.length > 0) {
    await db.insert(userEntries).values(
      options.userIds.map((userId) => ({
        userId,
        entryId,
        read: false,
        starred: false,
      }))
    );
  }

  return entryId;
}

// ============================================================================
// Tests
// ============================================================================

describe("Tags API", () => {
  // Clean up tables before each test
  beforeEach(async () => {
    await db.delete(userEntries);
    await db.delete(entries);
    await db.delete(subscriptionTags);
    await db.delete(tags);
    await db.delete(subscriptions);
    await db.delete(feeds);
    await db.delete(users);
  });

  // Clean up after all tests
  afterAll(async () => {
    await db.delete(userEntries);
    await db.delete(entries);
    await db.delete(subscriptionTags);
    await db.delete(tags);
    await db.delete(subscriptions);
    await db.delete(feeds);
    await db.delete(users);
  });

  describe("tags.list", () => {
    it("returns empty list for user with no tags", async () => {
      const userId = await createTestUser();
      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);

      const result = await caller.tags.list();

      expect(result.items).toEqual([]);
    });

    it("returns tags for the authenticated user only", async () => {
      const userId1 = await createTestUser();
      const userId2 = await createTestUser("other");

      // Create tags for both users
      const tag1Id = generateUuidv7();
      const tag2Id = generateUuidv7();
      const tag3Id = generateUuidv7();

      await db.insert(tags).values([
        { id: tag1Id, userId: userId1, name: "Tech", color: "#ff6b6b", createdAt: new Date() },
        { id: tag2Id, userId: userId1, name: "News", color: "#4ecdc4", createdAt: new Date() },
        { id: tag3Id, userId: userId2, name: "Sports", color: "#45b7d1", createdAt: new Date() },
      ]);

      const ctx1 = createAuthContext(userId1);
      const caller1 = createCaller(ctx1);
      const result1 = await caller1.tags.list();

      // User 1 should only see their own tags
      expect(result1.items).toHaveLength(2);
      expect(result1.items.map((t) => t.name).sort()).toEqual(["News", "Tech"]);

      const ctx2 = createAuthContext(userId2);
      const caller2 = createCaller(ctx2);
      const result2 = await caller2.tags.list();

      // User 2 should only see their own tags
      expect(result2.items).toHaveLength(1);
      expect(result2.items[0].name).toBe("Sports");
    });

    it("returns tags with correct feed counts", async () => {
      const userId = await createTestUser();

      // Create a tag
      const tagId = generateUuidv7();
      await db.insert(tags).values({
        id: tagId,
        userId,
        name: "Tech",
        color: "#ff6b6b",
        createdAt: new Date(),
      });

      // Create feeds and subscriptions
      const feedId1 = await createTestFeed("https://feed1.com/rss");
      const feedId2 = await createTestFeed("https://feed2.com/rss");
      const subId1 = await createTestSubscription(userId, feedId1);
      const subId2 = await createTestSubscription(userId, feedId2);

      // Link subscriptions to tag
      await linkTagToSubscription(tagId, subId1);
      await linkTagToSubscription(tagId, subId2);

      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);
      const result = await caller.tags.list();

      expect(result.items).toHaveLength(1);
      expect(result.items[0].feedCount).toBe(2);
    });

    it("returns tags with correct unread counts", async () => {
      const userId = await createTestUser();

      const techTagId = generateUuidv7();
      const emptyTagId = generateUuidv7();
      await db.insert(tags).values([
        { id: techTagId, userId, name: "Tech", createdAt: new Date() },
        { id: emptyTagId, userId, name: "Empty", createdAt: new Date() },
      ]);

      const feedId1 = await createTestFeed("https://feed1.com/rss");
      const feedId2 = await createTestFeed("https://feed2.com/rss");
      const subId1 = await createTestSubscription(userId, feedId1);
      const subId2 = await createTestSubscription(userId, feedId2);
      await linkTagToSubscription(techTagId, subId1);
      await linkTagToSubscription(techTagId, subId2);

      // feed1: 2 unread entries; feed2: 1 unread + 1 read entry
      await createTestEntry(feedId1, { userIds: [userId] });
      await createTestEntry(feedId1, { userIds: [userId] });
      await createTestEntry(feedId2, { userIds: [userId] });
      const readEntryId = await createTestEntry(feedId2, { userIds: [userId] });
      await db
        .update(userEntries)
        .set({ read: true })
        .where(and(eq(userEntries.userId, userId), eq(userEntries.entryId, readEntryId)));

      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);
      const result = await caller.tags.list();

      const tech = result.items.find((t) => t.name === "Tech");
      const empty = result.items.find((t) => t.name === "Empty");
      expect(tech?.unreadCount).toBe(3);
      expect(empty?.unreadCount).toBe(0);
    });

    it("deduplicates unread entries reachable through multiple subscriptions of the same tag", async () => {
      const userId = await createTestUser();

      const tagId = generateUuidv7();
      await db.insert(tags).values({ id: tagId, userId, name: "Tech", createdAt: new Date() });

      // sub1 subscribed to feedA but previously covered feedB (redirect/merge
      // history), so subscription_feeds maps it to both. sub2 is subscribed to
      // feedB directly. An unread entry in feedB is reachable through both
      // subscriptions and must be counted once.
      const feedIdA = await createTestFeed("https://feed-a.com/rss");
      const feedIdB = await createTestFeed("https://feed-b.com/rss");
      const subId1 = await createTestSubscription(userId, feedIdA);
      const subId2 = await createTestSubscription(userId, feedIdB);
      await db
        .insert(subscriptionFeeds)
        .values({ subscriptionId: subId1, feedId: feedIdB, userId });
      await linkTagToSubscription(tagId, subId1);
      await linkTagToSubscription(tagId, subId2);

      await createTestEntry(feedIdA, { userIds: [userId] });
      await createTestEntry(feedIdB, { userIds: [userId] });

      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);
      const result = await caller.tags.list();

      expect(result.items[0].unreadCount).toBe(2);
    });

    it("does not count other users' unread entries on shared feeds", async () => {
      const userId = await createTestUser("user-a");
      const otherUserId = await createTestUser("user-b");

      // Both users subscribe to the same feed and tag their subscriptions
      const feedId = await createTestFeed("https://shared.com/rss");
      const subId = await createTestSubscription(userId, feedId);
      const otherSubId = await createTestSubscription(otherUserId, feedId);

      const tagId = generateUuidv7();
      const otherTagId = generateUuidv7();
      await db.insert(tags).values([
        { id: tagId, userId, name: "Mine", createdAt: new Date() },
        { id: otherTagId, userId: otherUserId, name: "Theirs", createdAt: new Date() },
      ]);
      await linkTagToSubscription(tagId, subId);
      await linkTagToSubscription(otherTagId, otherSubId);

      // One entry visible to both users, one visible only to the other user
      await createTestEntry(feedId, { userIds: [userId, otherUserId] });
      await createTestEntry(feedId, { userIds: [otherUserId] });

      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);
      const result = await caller.tags.list();

      expect(result.items).toHaveLength(1);
      expect(result.items[0].name).toBe("Mine");
      expect(result.items[0].unreadCount).toBe(1);
    });

    it("excludes unread entries from unsubscribed subscriptions", async () => {
      const userId = await createTestUser();

      const tagId = generateUuidv7();
      await db.insert(tags).values({ id: tagId, userId, name: "Tech", createdAt: new Date() });

      const feedId = await createTestFeed("https://feed1.com/rss");
      const subId = await createTestSubscription(userId, feedId);
      await linkTagToSubscription(tagId, subId);
      await createTestEntry(feedId, { userIds: [userId] });

      await db
        .update(subscriptions)
        .set({ unsubscribedAt: new Date() })
        .where(eq(subscriptions.id, subId));

      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);
      const result = await caller.tags.list();

      expect(result.items[0].unreadCount).toBe(0);
    });

    it("excludes starred entries from unsubscribed subscriptions", async () => {
      // A starred entry stays visible after unsubscribe (visible_entries surfaces
      // it with the unsubscribed sub's id). It must not count toward the tag's
      // unread badge — the count is scoped to active subscriptions.
      const userId = await createTestUser();

      const tagId = generateUuidv7();
      await db.insert(tags).values({ id: tagId, userId, name: "Tech", createdAt: new Date() });

      const feedId = await createTestFeed("https://feed1.com/rss");
      const subId = await createTestSubscription(userId, feedId);
      await linkTagToSubscription(tagId, subId);
      const entryId = await createTestEntry(feedId, { userIds: [userId] });
      await db
        .update(userEntries)
        .set({ starred: true })
        .where(and(eq(userEntries.userId, userId), eq(userEntries.entryId, entryId)));
      await db
        .update(subscriptions)
        .set({ unsubscribedAt: new Date() })
        .where(eq(subscriptions.id, subId));

      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);
      const result = await caller.tags.list();

      expect(result.items[0].unreadCount).toBe(0);
    });

    it("returns zero unread for a tag whose entries are all read", async () => {
      const userId = await createTestUser();

      const tagId = generateUuidv7();
      await db.insert(tags).values({ id: tagId, userId, name: "Tech", createdAt: new Date() });

      const feedId = await createTestFeed("https://feed1.com/rss");
      const subId = await createTestSubscription(userId, feedId);
      await linkTagToSubscription(tagId, subId);
      const entryId = await createTestEntry(feedId, { userIds: [userId] });
      await db
        .update(userEntries)
        .set({ read: true })
        .where(and(eq(userEntries.userId, userId), eq(userEntries.entryId, entryId)));

      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);
      const result = await caller.tags.list();

      expect(result.items[0].feedCount).toBe(1);
      expect(result.items[0].unreadCount).toBe(0);
    });

    it("returns tags ordered by name", async () => {
      const userId = await createTestUser();

      // Create tags in random order
      await db.insert(tags).values([
        { id: generateUuidv7(), userId, name: "Zebra", createdAt: new Date() },
        { id: generateUuidv7(), userId, name: "Apple", createdAt: new Date() },
        { id: generateUuidv7(), userId, name: "Middle", createdAt: new Date() },
      ]);

      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);
      const result = await caller.tags.list();

      expect(result.items.map((t) => t.name)).toEqual(["Apple", "Middle", "Zebra"]);
    });
  });

  describe("tags.create", () => {
    it("creates a tag with name only", async () => {
      const userId = await createTestUser();
      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);

      const result = await caller.tags.create({ name: "Tech" });

      expect(result.tag.name).toBe("Tech");
      expect(result.tag.color).toBeNull();
      expect(result.tag.feedCount).toBe(0);
      expect(result.tag.id).toBeDefined();
      expect(result.tag.createdAt).toBeInstanceOf(Date);

      // Verify in database
      const dbTag = await db.select().from(tags).where(eq(tags.id, result.tag.id)).limit(1);
      expect(dbTag).toHaveLength(1);
      expect(dbTag[0].name).toBe("Tech");
      expect(dbTag[0].userId).toBe(userId);
    });

    it("creates a tag with name and color", async () => {
      const userId = await createTestUser();
      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);

      const result = await caller.tags.create({ name: "News", color: "#4ecdc4" });

      expect(result.tag.name).toBe("News");
      expect(result.tag.color).toBe("#4ecdc4");
    });

    it("trims whitespace from tag name", async () => {
      const userId = await createTestUser();
      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);

      const result = await caller.tags.create({ name: "  Tech  " });

      expect(result.tag.name).toBe("Tech");
    });

    it("rejects duplicate tag names for the same user", async () => {
      const userId = await createTestUser();
      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);

      await caller.tags.create({ name: "Tech" });

      await expect(caller.tags.create({ name: "Tech" })).rejects.toThrow(
        "A tag with this name already exists"
      );
    });

    it("allows same tag name for different users", async () => {
      const userId1 = await createTestUser();
      const userId2 = await createTestUser("other");

      const ctx1 = createAuthContext(userId1);
      const caller1 = createCaller(ctx1);
      await caller1.tags.create({ name: "Tech" });

      const ctx2 = createAuthContext(userId2);
      const caller2 = createCaller(ctx2);
      const result = await caller2.tags.create({ name: "Tech" });

      expect(result.tag.name).toBe("Tech");
    });

    it("allows recreating a tag whose name was soft-deleted (#952)", async () => {
      const userId = await createTestUser();
      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);

      const first = await caller.tags.create({ name: "News" });
      await caller.tags.delete({ id: first.tag.id });

      // Re-creating "News" must succeed: the tombstoned row uses a partial
      // unique index (deleted_at IS NULL) so it no longer blocks the name.
      const second = await caller.tags.create({ name: "News" });
      expect(second.tag.name).toBe("News");
      expect(second.tag.id).not.toBe(first.tag.id);

      // The live tag is the new one; the tombstone stays soft-deleted.
      const live = await db
        .select()
        .from(tags)
        .where(and(eq(tags.userId, userId), isNull(tags.deletedAt)));
      expect(live).toHaveLength(1);
      expect(live[0].id).toBe(second.tag.id);
    });

    it("allows renaming a tag onto a soft-deleted name (#952)", async () => {
      const userId = await createTestUser();
      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);

      const deleted = await caller.tags.create({ name: "Archive" });
      await caller.tags.delete({ id: deleted.tag.id });
      const keep = await caller.tags.create({ name: "Inbox" });

      // Renaming "Inbox" → "Archive" must not collide with the tombstone.
      const renamed = await caller.tags.update({ id: keep.tag.id, name: "Archive" });
      expect(renamed.tag.name).toBe("Archive");
    });

    it("rejects empty tag name", async () => {
      const userId = await createTestUser();
      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);

      await expect(caller.tags.create({ name: "" })).rejects.toThrow();
    });

    it("rejects tag name that is too long", async () => {
      const userId = await createTestUser();
      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);

      const longName = "a".repeat(51);
      await expect(caller.tags.create({ name: longName })).rejects.toThrow();
    });

    it("rejects invalid color format", async () => {
      const userId = await createTestUser();
      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);

      await expect(caller.tags.create({ name: "Tech", color: "red" })).rejects.toThrow();
      await expect(caller.tags.create({ name: "Tech", color: "#fff" })).rejects.toThrow();
      await expect(caller.tags.create({ name: "Tech", color: "ff6b6b" })).rejects.toThrow();
    });
  });

  describe("tags.update", () => {
    it("updates tag name", async () => {
      const userId = await createTestUser();
      const tagId = generateUuidv7();
      await db.insert(tags).values({
        id: tagId,
        userId,
        name: "Tech",
        createdAt: new Date(),
      });

      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);

      const result = await caller.tags.update({ id: tagId, name: "Technology" });

      expect(result.tag.name).toBe("Technology");
    });

    it("updates tag color", async () => {
      const userId = await createTestUser();
      const tagId = generateUuidv7();
      await db.insert(tags).values({
        id: tagId,
        userId,
        name: "Tech",
        color: "#ff6b6b",
        createdAt: new Date(),
      });

      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);

      const result = await caller.tags.update({ id: tagId, color: "#4ecdc4" });

      expect(result.tag.color).toBe("#4ecdc4");
    });

    it("removes tag color when set to null", async () => {
      const userId = await createTestUser();
      const tagId = generateUuidv7();
      await db.insert(tags).values({
        id: tagId,
        userId,
        name: "Tech",
        color: "#ff6b6b",
        createdAt: new Date(),
      });

      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);

      const result = await caller.tags.update({ id: tagId, color: null });

      expect(result.tag.color).toBeNull();
    });

    it("updates both name and color", async () => {
      const userId = await createTestUser();
      const tagId = generateUuidv7();
      await db.insert(tags).values({
        id: tagId,
        userId,
        name: "Tech",
        color: "#ff6b6b",
        createdAt: new Date(),
      });

      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);

      const result = await caller.tags.update({
        id: tagId,
        name: "Technology",
        color: "#4ecdc4",
      });

      expect(result.tag.name).toBe("Technology");
      expect(result.tag.color).toBe("#4ecdc4");
    });

    it("returns correct feed count after update", async () => {
      const userId = await createTestUser();
      const tagId = generateUuidv7();
      await db.insert(tags).values({
        id: tagId,
        userId,
        name: "Tech",
        createdAt: new Date(),
      });

      // Create feed, subscription, and link
      const feedId = await createTestFeed("https://feed1.com/rss");
      const subId = await createTestSubscription(userId, feedId);
      await linkTagToSubscription(tagId, subId);

      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);

      const result = await caller.tags.update({ id: tagId, name: "Technology" });

      expect(result.tag.feedCount).toBe(1);
    });

    it("returns unread count consistent with tags.list", async () => {
      const userId = await createTestUser("user-a");
      const otherUserId = await createTestUser("user-b");

      const tagId = generateUuidv7();
      await db.insert(tags).values({ id: tagId, userId, name: "Tech", createdAt: new Date() });

      // Overlapping subscription_feeds within the tag (dedup case) plus a
      // second user on the shared feed (scoping case) — update must count the
      // same way list does.
      const feedIdA = await createTestFeed("https://feed-a.com/rss");
      const feedIdB = await createTestFeed("https://feed-b.com/rss");
      const subId1 = await createTestSubscription(userId, feedIdA);
      const subId2 = await createTestSubscription(userId, feedIdB);
      await db
        .insert(subscriptionFeeds)
        .values({ subscriptionId: subId1, feedId: feedIdB, userId });
      await linkTagToSubscription(tagId, subId1);
      await linkTagToSubscription(tagId, subId2);
      await createTestSubscription(otherUserId, feedIdB);

      await createTestEntry(feedIdA, { userIds: [userId] });
      await createTestEntry(feedIdB, { userIds: [userId, otherUserId] });

      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);

      const updateResult = await caller.tags.update({ id: tagId, name: "Technology" });
      const listResult = await caller.tags.list();

      expect(updateResult.tag.unreadCount).toBe(2);
      expect(listResult.items[0].unreadCount).toBe(2);
    });

    it("throws error when tag not found", async () => {
      const userId = await createTestUser();
      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);

      const nonExistentId = generateUuidv7();
      await expect(caller.tags.update({ id: nonExistentId, name: "New Name" })).rejects.toThrow(
        "Tag not found"
      );
    });

    it("throws error when updating another user's tag", async () => {
      const userId1 = await createTestUser();
      const userId2 = await createTestUser("other");

      const tagId = generateUuidv7();
      await db.insert(tags).values({
        id: tagId,
        userId: userId1,
        name: "Tech",
        createdAt: new Date(),
      });

      // User 2 tries to update User 1's tag
      const ctx = createAuthContext(userId2);
      const caller = createCaller(ctx);

      await expect(caller.tags.update({ id: tagId, name: "Hacked" })).rejects.toThrow(
        "Tag not found"
      );
    });

    it("rejects duplicate name when updating", async () => {
      const userId = await createTestUser();

      await db.insert(tags).values([
        { id: generateUuidv7(), userId, name: "Tech", createdAt: new Date() },
        { id: generateUuidv7(), userId, name: "News", createdAt: new Date() },
      ]);

      const techTag = await db
        .select()
        .from(tags)
        .where(and(eq(tags.userId, userId), eq(tags.name, "Tech")))
        .limit(1);

      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);

      await expect(caller.tags.update({ id: techTag[0].id, name: "News" })).rejects.toThrow(
        "A tag with this name already exists"
      );
    });

    it("allows keeping the same name when updating only color", async () => {
      const userId = await createTestUser();
      const tagId = generateUuidv7();
      await db.insert(tags).values({
        id: tagId,
        userId,
        name: "Tech",
        createdAt: new Date(),
      });

      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);

      // This should not throw even though the name "Tech" exists
      const result = await caller.tags.update({ id: tagId, color: "#ff6b6b" });

      expect(result.tag.name).toBe("Tech");
      expect(result.tag.color).toBe("#ff6b6b");
    });
  });

  describe("tags.delete", () => {
    it("deletes a tag", async () => {
      const userId = await createTestUser();
      const tagId = generateUuidv7();
      await db.insert(tags).values({
        id: tagId,
        userId,
        name: "Tech",
        createdAt: new Date(),
      });

      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);

      const result = await caller.tags.delete({ id: tagId });

      expect(result.success).toBe(true);

      // Verify tag is soft deleted (deleted_at is set)
      const dbTag = await db.select().from(tags).where(eq(tags.id, tagId)).limit(1);
      expect(dbTag).toHaveLength(1);
      expect(dbTag[0].deletedAt).not.toBeNull();
    });

    it("cascades deletion to subscription_tags", async () => {
      const userId = await createTestUser();
      const tagId = generateUuidv7();
      await db.insert(tags).values({
        id: tagId,
        userId,
        name: "Tech",
        createdAt: new Date(),
      });

      // Create feed, subscription, and link
      const feedId = await createTestFeed("https://feed1.com/rss");
      const subId = await createTestSubscription(userId, feedId);
      await linkTagToSubscription(tagId, subId);

      // Verify link exists
      const linksBefore = await db
        .select()
        .from(subscriptionTags)
        .where(eq(subscriptionTags.tagId, tagId));
      expect(linksBefore).toHaveLength(1);

      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);
      await caller.tags.delete({ id: tagId });

      // Verify link is deleted
      const linksAfter = await db
        .select()
        .from(subscriptionTags)
        .where(eq(subscriptionTags.tagId, tagId));
      expect(linksAfter).toHaveLength(0);

      // Verify subscription still exists
      const sub = await db.select().from(subscriptions).where(eq(subscriptions.id, subId)).limit(1);
      expect(sub).toHaveLength(1);
    });

    it("throws error when tag not found", async () => {
      const userId = await createTestUser();
      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);

      const nonExistentId = generateUuidv7();
      await expect(caller.tags.delete({ id: nonExistentId })).rejects.toThrow("Tag not found");
    });

    it("throws error when deleting another user's tag", async () => {
      const userId1 = await createTestUser();
      const userId2 = await createTestUser("other");

      const tagId = generateUuidv7();
      await db.insert(tags).values({
        id: tagId,
        userId: userId1,
        name: "Tech",
        createdAt: new Date(),
      });

      // User 2 tries to delete User 1's tag
      const ctx = createAuthContext(userId2);
      const caller = createCaller(ctx);

      await expect(caller.tags.delete({ id: tagId })).rejects.toThrow("Tag not found");

      // Verify tag still exists
      const dbTag = await db.select().from(tags).where(eq(tags.id, tagId)).limit(1);
      expect(dbTag).toHaveLength(1);
    });
  });

  describe("authentication", () => {
    it("requires authentication for list", async () => {
      const ctx = createUnauthContext();
      const caller = createCaller(ctx);

      await expect(caller.tags.list()).rejects.toThrow("You must be logged in");
    });

    it("requires authentication for create", async () => {
      const ctx = createUnauthContext();
      const caller = createCaller(ctx);

      await expect(caller.tags.create({ name: "Tech" })).rejects.toThrow("You must be logged in");
    });

    it("requires authentication for update", async () => {
      const ctx = createUnauthContext();
      const caller = createCaller(ctx);

      await expect(caller.tags.update({ id: generateUuidv7(), name: "Tech" })).rejects.toThrow(
        "You must be logged in"
      );
    });

    it("requires authentication for delete", async () => {
      const ctx = createUnauthContext();
      const caller = createCaller(ctx);

      await expect(caller.tags.delete({ id: generateUuidv7() })).rejects.toThrow(
        "You must be logged in"
      );
    });
  });

  describe("subscriptions.setTags", () => {
    it("sets tags on a subscription", async () => {
      const userId = await createTestUser();
      const feedId = await createTestFeed("https://feed1.com/rss");
      const subId = await createTestSubscription(userId, feedId);

      // Create tags
      const tag1Id = generateUuidv7();
      const tag2Id = generateUuidv7();
      await db.insert(tags).values([
        { id: tag1Id, userId, name: "Tech", color: "#ff6b6b", createdAt: new Date() },
        { id: tag2Id, userId, name: "News", color: "#4ecdc4", createdAt: new Date() },
      ]);

      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);

      const result = await caller.subscriptions.setTags({ id: subId, tagIds: [tag1Id, tag2Id] });

      expect(result).toEqual({});

      // Verify tags are set in database
      const dbTags = await db
        .select()
        .from(subscriptionTags)
        .where(eq(subscriptionTags.subscriptionId, subId));
      expect(dbTags).toHaveLength(2);
      expect(dbTags.map((t) => t.tagId).sort()).toEqual([tag1Id, tag2Id].sort());
    });

    it("replaces existing tags", async () => {
      const userId = await createTestUser();
      const feedId = await createTestFeed("https://feed1.com/rss");
      const subId = await createTestSubscription(userId, feedId);

      // Create tags
      const tag1Id = generateUuidv7();
      const tag2Id = generateUuidv7();
      const tag3Id = generateUuidv7();
      await db.insert(tags).values([
        { id: tag1Id, userId, name: "Tech", createdAt: new Date() },
        { id: tag2Id, userId, name: "News", createdAt: new Date() },
        { id: tag3Id, userId, name: "Sports", createdAt: new Date() },
      ]);

      // Link initial tags
      await linkTagToSubscription(tag1Id, subId);
      await linkTagToSubscription(tag2Id, subId);

      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);

      // Replace with new tag
      await caller.subscriptions.setTags({ id: subId, tagIds: [tag3Id] });

      // Verify tags are replaced
      const dbTags = await db
        .select()
        .from(subscriptionTags)
        .where(eq(subscriptionTags.subscriptionId, subId));
      expect(dbTags).toHaveLength(1);
      expect(dbTags[0].tagId).toBe(tag3Id);
    });

    it("removes all tags when given empty array", async () => {
      const userId = await createTestUser();
      const feedId = await createTestFeed("https://feed1.com/rss");
      const subId = await createTestSubscription(userId, feedId);

      // Create and link a tag
      const tagId = generateUuidv7();
      await db.insert(tags).values({ id: tagId, userId, name: "Tech", createdAt: new Date() });
      await linkTagToSubscription(tagId, subId);

      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);

      await caller.subscriptions.setTags({ id: subId, tagIds: [] });

      // Verify all tags are removed
      const dbTags = await db
        .select()
        .from(subscriptionTags)
        .where(eq(subscriptionTags.subscriptionId, subId));
      expect(dbTags).toHaveLength(0);
    });

    it("throws error for non-existent subscription", async () => {
      const userId = await createTestUser();
      const tagId = generateUuidv7();
      await db.insert(tags).values({ id: tagId, userId, name: "Tech", createdAt: new Date() });

      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);

      await expect(
        caller.subscriptions.setTags({ id: generateUuidv7(), tagIds: [tagId] })
      ).rejects.toThrow("Subscription not found");
    });

    it("throws error for another user's subscription", async () => {
      const userId1 = await createTestUser();
      const userId2 = await createTestUser("other");

      const feedId = await createTestFeed("https://feed1.com/rss");
      const subId = await createTestSubscription(userId1, feedId);

      const tagId = generateUuidv7();
      await db
        .insert(tags)
        .values({ id: tagId, userId: userId2, name: "Tech", createdAt: new Date() });

      // User 2 tries to set tags on User 1's subscription
      const ctx = createAuthContext(userId2);
      const caller = createCaller(ctx);

      await expect(caller.subscriptions.setTags({ id: subId, tagIds: [tagId] })).rejects.toThrow(
        "Subscription not found"
      );
    });

    it("throws error for invalid tag IDs", async () => {
      const userId = await createTestUser();
      const feedId = await createTestFeed("https://feed1.com/rss");
      const subId = await createTestSubscription(userId, feedId);

      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);

      // Try to set a non-existent tag
      await expect(
        caller.subscriptions.setTags({ id: subId, tagIds: [generateUuidv7()] })
      ).rejects.toThrow("One or more tag IDs are invalid or do not belong to you");
    });

    it("throws error for another user's tags", async () => {
      const userId1 = await createTestUser();
      const userId2 = await createTestUser("other");

      const feedId = await createTestFeed("https://feed1.com/rss");
      const subId = await createTestSubscription(userId1, feedId);

      // Create tag owned by user 2
      const tagId = generateUuidv7();
      await db
        .insert(tags)
        .values({ id: tagId, userId: userId2, name: "Tech", createdAt: new Date() });

      // User 1 tries to use User 2's tag
      const ctx = createAuthContext(userId1);
      const caller = createCaller(ctx);

      await expect(caller.subscriptions.setTags({ id: subId, tagIds: [tagId] })).rejects.toThrow(
        "One or more tag IDs are invalid or do not belong to you"
      );
    });
  });

  describe("subscriptions.list with tags", () => {
    it("returns subscriptions with their tags", async () => {
      const userId = await createTestUser();
      const feedId = await createTestFeed("https://feed1.com/rss");
      const subId = await createTestSubscription(userId, feedId);

      // Create and link tags
      const tag1Id = generateUuidv7();
      const tag2Id = generateUuidv7();
      await db.insert(tags).values([
        { id: tag1Id, userId, name: "Tech", color: "#ff6b6b", createdAt: new Date() },
        { id: tag2Id, userId, name: "News", color: "#4ecdc4", createdAt: new Date() },
      ]);
      await linkTagToSubscription(tag1Id, subId);
      await linkTagToSubscription(tag2Id, subId);

      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);

      const result = await caller.subscriptions.list();

      expect(result.items).toHaveLength(1);
      expect(result.items[0].tags).toHaveLength(2);
      expect(result.items[0].tags.map((t) => t.name).sort()).toEqual(["News", "Tech"]);
    });

    it("returns empty tags array for subscriptions without tags", async () => {
      const userId = await createTestUser();
      const feedId = await createTestFeed("https://feed1.com/rss");
      await createTestSubscription(userId, feedId);

      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);

      const result = await caller.subscriptions.list();

      expect(result.items).toHaveLength(1);
      expect(result.items[0].tags).toEqual([]);
    });
  });

  describe("subscriptions.list unread counts", () => {
    it("counts unread entries reachable through a merged/redirected feed", async () => {
      // Regression: the per-subscription unread count must follow the
      // subscription_feeds mapping (via visible_entries), not just the
      // subscription's current feed_id. A subscription that absorbed a
      // redirected/merged feed owns entries under the old feed_id too; counting
      // only the current feed_id silently undercounts them.
      const userId = await createTestUser();

      const feedIdA = await createTestFeed("https://feed-a.com/rss"); // current feed
      const feedIdB = await createTestFeed("https://feed-b.com/rss"); // merged-in old feed
      const subId = await createTestSubscription(userId, feedIdA);
      // subscription_feeds links the subscription to BOTH feeds (merge history).
      await db
        .insert(subscriptionFeeds)
        .values({ subscriptionId: subId, feedId: feedIdB, userId })
        .onConflictDoNothing();

      // 2 unread under the current feed, 1 unread under the merged-in feed.
      await createTestEntry(feedIdA, { userIds: [userId] });
      await createTestEntry(feedIdA, { userIds: [userId] });
      await createTestEntry(feedIdB, { userIds: [userId] });

      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);
      const result = await caller.subscriptions.list();

      expect(result.items).toHaveLength(1);
      expect(result.items[0].unreadCount).toBe(3);
    });

    it("does not count another user's unread entries on a shared feed", async () => {
      // The per-subscription count must stay user-scoped: subscription_feeds is
      // per-user and feeds are shared, so a missing user filter would leak other
      // users' unread counts.
      const userId = await createTestUser("user-a");
      const otherUserId = await createTestUser("user-b");

      const feedId = await createTestFeed("https://shared.com/rss");
      await createTestSubscription(userId, feedId);
      await createTestSubscription(otherUserId, feedId);

      // One entry visible only to the other user.
      await createTestEntry(feedId, { userIds: [userId] });
      await createTestEntry(feedId, { userIds: [otherUserId] });

      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);
      const result = await caller.subscriptions.list();

      expect(result.items).toHaveLength(1);
      expect(result.items[0].unreadCount).toBe(1);
    });
  });

  describe("tags.list uncategorized counts", () => {
    it("counts active untagged subscriptions and their unread entries", async () => {
      const userId = await createTestUser();

      // One tagged subscription, one untagged (uncategorized) subscription.
      const taggedFeed = await createTestFeed("https://tagged.com/rss");
      const untaggedFeed = await createTestFeed("https://untagged.com/rss");
      const taggedSub = await createTestSubscription(userId, taggedFeed);
      await createTestSubscription(userId, untaggedFeed);

      const tagId = generateUuidv7();
      await db.insert(tags).values({ id: tagId, userId, name: "Tech", createdAt: new Date() });
      await linkTagToSubscription(tagId, taggedSub);

      await createTestEntry(taggedFeed, { userIds: [userId] }); // counts toward the tag
      await createTestEntry(untaggedFeed, { userIds: [userId] }); // uncategorized
      await createTestEntry(untaggedFeed, { userIds: [userId] }); // uncategorized

      const ctx = createAuthContext(userId);
      const result = await createCaller(ctx).tags.list();

      expect(result.uncategorized.feedCount).toBe(1);
      expect(result.uncategorized.unreadCount).toBe(2);
    });

    it("counts uncategorized unread entries reachable through a merged feed", async () => {
      const userId = await createTestUser();

      const feedIdA = await createTestFeed("https://feed-a.com/rss");
      const feedIdB = await createTestFeed("https://feed-b.com/rss");
      const subId = await createTestSubscription(userId, feedIdA); // untagged
      await db
        .insert(subscriptionFeeds)
        .values({ subscriptionId: subId, feedId: feedIdB, userId })
        .onConflictDoNothing();

      await createTestEntry(feedIdA, { userIds: [userId] });
      await createTestEntry(feedIdB, { userIds: [userId] });

      const ctx = createAuthContext(userId);
      const result = await createCaller(ctx).tags.list();

      expect(result.uncategorized.unreadCount).toBe(2);
    });

    it("excludes starred entries from unsubscribed untagged subscriptions", async () => {
      // visible_entries surfaces starred entries from unsubscribed feeds (with a
      // non-null subscription_id pointing at the unsubscribed sub). Those belong
      // to Starred, not Uncategorized — the count must stay scoped to active subs.
      const userId = await createTestUser();

      const activeFeed = await createTestFeed("https://active.com/rss");
      await createTestSubscription(userId, activeFeed);
      await createTestEntry(activeFeed, { userIds: [userId] }); // 1 active uncategorized unread

      const goneFeed = await createTestFeed("https://gone.com/rss");
      const goneSub = await createTestSubscription(userId, goneFeed);
      await db
        .update(subscriptions)
        .set({ unsubscribedAt: new Date() })
        .where(eq(subscriptions.id, goneSub));
      const starredEntry = await createTestEntry(goneFeed, { userIds: [userId] });
      await db
        .update(userEntries)
        .set({ starred: true })
        .where(and(eq(userEntries.userId, userId), eq(userEntries.entryId, starredEntry)));

      const ctx = createAuthContext(userId);
      const result = await createCaller(ctx).tags.list();

      // Only the active subscription's unread entry — not the starred orphan.
      expect(result.uncategorized.feedCount).toBe(1);
      expect(result.uncategorized.unreadCount).toBe(1);
    });
  });

  describe("entries.list with tagId filter", () => {
    it("filters entries by tag", async () => {
      const userId = await createTestUser();

      // Create two feeds with subscriptions
      const feedId1 = await createTestFeed("https://feed1.com/rss");
      const feedId2 = await createTestFeed("https://feed2.com/rss");
      const subId1 = await createTestSubscription(userId, feedId1);
      await createTestSubscription(userId, feedId2);

      // Create a tag and link it to subscription 1 only
      const tagId = generateUuidv7();
      await db.insert(tags).values({ id: tagId, userId, name: "Tech", createdAt: new Date() });
      await linkTagToSubscription(tagId, subId1);

      // Create entries for both feeds with user_entries for visibility
      const entryId1 = await createTestEntry(feedId1, {
        title: "Entry from Feed 1",
        userIds: [userId],
      });
      await createTestEntry(feedId2, { title: "Entry from Feed 2", userIds: [userId] });

      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);

      // Filter by tag - should only return entries from feed 1
      const result = await caller.entries.list({ tagId });

      expect(result.items).toHaveLength(1);
      expect(result.items[0].id).toBe(entryId1);
      expect(result.items[0].title).toBe("Entry from Feed 1");
    });

    it("returns empty list when tag has no subscriptions", async () => {
      const userId = await createTestUser();

      // Create a feed with subscription
      const feedId = await createTestFeed("https://feed1.com/rss");
      await createTestSubscription(userId, feedId);

      // Create a tag with no subscriptions linked
      const tagId = generateUuidv7();
      await db.insert(tags).values({ id: tagId, userId, name: "Empty Tag", createdAt: new Date() });

      // Create an entry
      await createTestEntry(feedId, { title: "Test Entry" });

      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);

      // Filter by empty tag - should return empty
      const result = await caller.entries.list({ tagId });

      expect(result.items).toHaveLength(0);
    });

    it("returns empty list for non-existent tag", async () => {
      const userId = await createTestUser();

      const feedId = await createTestFeed("https://feed1.com/rss");
      await createTestSubscription(userId, feedId);
      await createTestEntry(feedId);

      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);

      // Filter by non-existent tag
      const result = await caller.entries.list({ tagId: generateUuidv7() });

      expect(result.items).toHaveLength(0);
    });

    it("returns empty list for another user's tag", async () => {
      const userId1 = await createTestUser();
      const userId2 = await createTestUser("other");

      // User 1 has a feed and subscription
      const feedId = await createTestFeed("https://feed1.com/rss");
      await createTestSubscription(userId1, feedId);
      await createTestEntry(feedId);

      // Tag owned by user 2
      const tagId = generateUuidv7();
      await db
        .insert(tags)
        .values({ id: tagId, userId: userId2, name: "Tech", createdAt: new Date() });

      // User 1 tries to filter by user 2's tag
      const ctx = createAuthContext(userId1);
      const caller = createCaller(ctx);

      const result = await caller.entries.list({ tagId });

      expect(result.items).toHaveLength(0);
    });

    it("combines tagId and feedId filters", async () => {
      const userId = await createTestUser();

      // Create two feeds with subscriptions
      const feedId1 = await createTestFeed("https://feed1.com/rss");
      const feedId2 = await createTestFeed("https://feed2.com/rss");
      const subId1 = await createTestSubscription(userId, feedId1);
      const subId2 = await createTestSubscription(userId, feedId2);

      // Create a tag and link it to both subscriptions
      const tagId = generateUuidv7();
      await db.insert(tags).values({ id: tagId, userId, name: "Tech", createdAt: new Date() });
      await linkTagToSubscription(tagId, subId1);
      await linkTagToSubscription(tagId, subId2);

      // Create entries for both feeds with user_entries for visibility
      const entryId1 = await createTestEntry(feedId1, {
        title: "Entry from Feed 1",
        userIds: [userId],
      });
      await createTestEntry(feedId2, { title: "Entry from Feed 2", userIds: [userId] });

      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);

      // Filter by tag AND subscriptionId - should only return entries from subscription 1
      const result = await caller.entries.list({ tagId, subscriptionId: subId1 });

      expect(result.items).toHaveLength(1);
      expect(result.items[0].id).toBe(entryId1);
    });

    it("returns empty when feedId is not in tag", async () => {
      const userId = await createTestUser();

      // Create two feeds with subscriptions
      const feedId1 = await createTestFeed("https://feed1.com/rss");
      const feedId2 = await createTestFeed("https://feed2.com/rss");
      const subId1 = await createTestSubscription(userId, feedId1);
      const subId2 = await createTestSubscription(userId, feedId2);

      // Create a tag and link it to subscription 1 only
      const tagId = generateUuidv7();
      await db.insert(tags).values({ id: tagId, userId, name: "Tech", createdAt: new Date() });
      await linkTagToSubscription(tagId, subId1);

      // Create entries for both feeds
      await createTestEntry(feedId1);
      await createTestEntry(feedId2);

      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);

      // Filter by tag AND subscriptionId (where subscription for feed2 is not in tag)
      const result = await caller.entries.list({ tagId, subscriptionId: subId2 });

      expect(result.items).toHaveLength(0);
    });
  });
});

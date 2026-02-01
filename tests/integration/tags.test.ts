/**
 * Integration tests for the Tags API.
 *
 * These tests use a real database to verify tag CRUD operations
 * and the proper handling of user isolation and authorization.
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { eq, and } from "drizzle-orm";
import { db } from "../../src/server/db";
import {
  users,
  tags,
  subscriptions,
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

/**
 * Integration tests for the entry counts service.
 *
 * These verify the per-tag and uncategorized unread counts used by mutations
 * and SSE cache updates, in particular that they deduplicate entries reachable
 * through multiple subscriptions (overlapping subscription_feeds rows from
 * feed redirect/merge history) and stay consistent with listTags.
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
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
import { getEntryRelatedCounts, getBulkEntryRelatedCounts } from "../../src/server/services/counts";

// ============================================================================
// Test Helpers
// ============================================================================

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

async function createTestEntry(feedId: string, userIds: string[]): Promise<string> {
  const entryId = generateUuidv7();
  const now = new Date();
  await db.insert(entries).values({
    id: entryId,
    feedId,
    type: "web",
    guid: `guid-${entryId}`,
    title: `Entry ${entryId}`,
    contentHash: `hash-${entryId}`,
    fetchedAt: now,
    lastSeenAt: now,
    createdAt: now,
    updatedAt: now,
  });

  if (userIds.length > 0) {
    await db.insert(userEntries).values(
      userIds.map((userId) => ({
        userId,
        entryId,
        read: false,
        starred: false,
      }))
    );
  }

  return entryId;
}

/**
 * Creates the overlapping-subscriptions fixture: sub1 covers feedA and feedB
 * (redirect/merge history in subscription_feeds), sub2 covers feedB directly.
 * An unread entry in feedB is visible through both subscriptions; an unread
 * entry in feedA only through sub1.
 */
async function createOverlappingSubscriptions(userId: string) {
  const feedIdA = await createTestFeed("https://feed-a.com/rss");
  const feedIdB = await createTestFeed("https://feed-b.com/rss");
  const subId1 = await createTestSubscription(userId, feedIdA);
  const subId2 = await createTestSubscription(userId, feedIdB);
  await db.insert(subscriptionFeeds).values({ subscriptionId: subId1, feedId: feedIdB, userId });

  const entryIdA = await createTestEntry(feedIdA, [userId]);
  const entryIdB = await createTestEntry(feedIdB, [userId]);

  return { feedIdA, feedIdB, subId1, subId2, entryIdA, entryIdB };
}

async function linkTag(userId: string, name: string, subscriptionIds: string[]): Promise<string> {
  const tagId = generateUuidv7();
  await db.insert(tags).values({ id: tagId, userId, name, createdAt: new Date() });
  await db.insert(subscriptionTags).values(
    subscriptionIds.map((subscriptionId) => ({
      tagId,
      subscriptionId,
      createdAt: new Date(),
    }))
  );
  return tagId;
}

// ============================================================================
// Tests
// ============================================================================

describe("Entry counts service", () => {
  beforeEach(async () => {
    await db.delete(userEntries);
    await db.delete(entries);
    await db.delete(subscriptionTags);
    await db.delete(tags);
    await db.delete(subscriptions);
    await db.delete(feeds);
    await db.delete(users);
  });

  afterAll(async () => {
    await db.delete(userEntries);
    await db.delete(entries);
    await db.delete(subscriptionTags);
    await db.delete(tags);
    await db.delete(subscriptions);
    await db.delete(feeds);
    await db.delete(users);
  });

  describe("getEntryRelatedCounts", () => {
    it("deduplicates tag counts for entries reachable through multiple subscriptions", async () => {
      const userId = await createTestUser();
      const { subId1, subId2, entryIdB } = await createOverlappingSubscriptions(userId);
      const tagId = await linkTag(userId, "Tech", [subId1, subId2]);

      const counts = await getEntryRelatedCounts(db, userId, entryIdB);

      expect(counts.tags).toEqual([{ id: tagId, unread: 2 }]);
    });

    it("deduplicates the uncategorized count for entries reachable through multiple subscriptions", async () => {
      const userId = await createTestUser();
      const { entryIdB } = await createOverlappingSubscriptions(userId);

      const counts = await getEntryRelatedCounts(db, userId, entryIdB);

      expect(counts.tags).toEqual([]);
      expect(counts.uncategorized).toEqual({ unread: 2 });
    });

    it("does not count other users' unread entries in tag counts", async () => {
      const userId = await createTestUser("user-a");
      const otherUserId = await createTestUser("user-b");

      const feedId = await createTestFeed("https://shared.com/rss");
      const subId = await createTestSubscription(userId, feedId);
      await createTestSubscription(otherUserId, feedId);
      const tagId = await linkTag(userId, "Mine", [subId]);

      const entryId = await createTestEntry(feedId, [userId, otherUserId]);
      await createTestEntry(feedId, [otherUserId]);

      const counts = await getEntryRelatedCounts(db, userId, entryId);

      expect(counts.tags).toEqual([{ id: tagId, unread: 1 }]);
    });
  });

  describe("getBulkEntryRelatedCounts", () => {
    it("deduplicates tag counts for entries reachable through multiple subscriptions", async () => {
      const userId = await createTestUser();
      const { subId1, subId2 } = await createOverlappingSubscriptions(userId);
      const tagId = await linkTag(userId, "Tech", [subId1, subId2]);

      const counts = await getBulkEntryRelatedCounts(db, userId, [
        { subscriptionId: subId1, type: "web" },
      ]);

      expect(counts.tags).toEqual([{ id: tagId, unread: 2 }]);
    });

    it("deduplicates the uncategorized count for entries reachable through multiple subscriptions", async () => {
      const userId = await createTestUser();
      const { subId1 } = await createOverlappingSubscriptions(userId);

      const counts = await getBulkEntryRelatedCounts(db, userId, [
        { subscriptionId: subId1, type: "web" },
      ]);

      expect(counts.tags).toEqual([]);
      expect(counts.uncategorized).toEqual({ unread: 2 });
    });
  });
});

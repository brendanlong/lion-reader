/**
 * Integration tests for the entry counts service.
 *
 * These verify the per-tag and uncategorized unread counts used by mutations
 * and SSE cache updates, in particular that they deduplicate entries reachable
 * through multiple subscriptions (overlapping subscription_feeds rows from
 * feed redirect/merge history) and stay consistent with listTags.
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";
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

async function markEntryRead(userId: string, entryId: string): Promise<void> {
  await db
    .update(userEntries)
    .set({ read: true })
    .where(and(eq(userEntries.userId, userId), eq(userEntries.entryId, entryId)));
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

    it("returns tags with unread 0 when the subscription's tags have no unread entries left", async () => {
      // Regression test: the tag counts query only groups over unread entries,
      // so when the last unread entry of a tagged subscription is read, the
      // tag produced no row and the (empty) result was misread as "the
      // subscription has no tags", returning the uncategorized count instead.
      // The client sets counts absolutely, so the tag badge went stale.
      const userId = await createTestUser();
      const feedId = await createTestFeed("https://events.com/rss");
      const subId = await createTestSubscription(userId, feedId);
      const tagId = await linkTag(userId, "Events", [subId]);
      const entryId = await createTestEntry(feedId, [userId]);
      await markEntryRead(userId, entryId);

      const counts = await getEntryRelatedCounts(db, userId, entryId);

      expect(counts.subscription).toEqual({ id: subId, unread: 0 });
      expect(counts.tags).toEqual([{ id: tagId, unread: 0 }]);
      expect(counts.uncategorized).toBeUndefined();
    });

    it("returns the real global counts when the entry is not visible to the user", async () => {
      // A caller patching these into the cache must not zero the user's
      // badges just because the target entry wasn't visible (issue #956).
      const userId = await createTestUser();
      const feedId = await createTestFeed("https://mine.com/rss");
      await createTestSubscription(userId, feedId);
      await createTestEntry(feedId, [userId]); // one real unread entry

      const counts = await getEntryRelatedCounts(db, userId, generateUuidv7());

      expect(counts.all).toEqual({ unread: 1 });
      expect(counts.starred).toEqual({ unread: 0 });
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

    it("returns subscription and tag with unread 0 when their last unread entry is read", async () => {
      // Regression test for the "mark the last entry read" bug: the grouped
      // subscription/tag count queries only return rows with unread entries,
      // so a subscription or tag that dropped to zero was omitted from the
      // result. The client applies these counts absolutely, so the sidebar
      // badge stayed at its previous value until a refresh.
      const userId = await createTestUser();
      const feedId = await createTestFeed("https://events.com/rss");
      const subId = await createTestSubscription(userId, feedId);
      const tagId = await linkTag(userId, "Events", [subId]);
      const entryId = await createTestEntry(feedId, [userId]);
      await markEntryRead(userId, entryId);

      const counts = await getBulkEntryRelatedCounts(db, userId, [
        { subscriptionId: subId, type: "web" },
      ]);

      expect(counts.all).toEqual({ unread: 0 });
      expect(counts.subscriptions).toEqual([{ id: subId, unread: 0 }]);
      expect(counts.tags).toEqual([{ id: tagId, unread: 0 }]);
    });

    it("returns unread 0 for the drained subscription while other counts stay correct", async () => {
      // Two tagged subscriptions; only one is drained. The drained one must be
      // zero-filled while the shared tag keeps counting the other's entries.
      const userId = await createTestUser();
      const feedIdA = await createTestFeed("https://drained.com/rss");
      const feedIdB = await createTestFeed("https://active.com/rss");
      const subIdA = await createTestSubscription(userId, feedIdA);
      const subIdB = await createTestSubscription(userId, feedIdB);
      const tagId = await linkTag(userId, "Mixed", [subIdA, subIdB]);
      const entryIdA = await createTestEntry(feedIdA, [userId]);
      await createTestEntry(feedIdB, [userId]);
      await markEntryRead(userId, entryIdA);

      const counts = await getBulkEntryRelatedCounts(db, userId, [
        { subscriptionId: subIdA, type: "web" },
      ]);

      expect(counts.all).toEqual({ unread: 1 });
      expect(counts.subscriptions).toEqual([{ id: subIdA, unread: 0 }]);
      expect(counts.tags).toEqual([{ id: tagId, unread: 1 }]);
    });

    it("returns unread 0 for an uncategorized subscription drained of unread entries", async () => {
      const userId = await createTestUser();
      const feedId = await createTestFeed("https://uncategorized.com/rss");
      const subId = await createTestSubscription(userId, feedId);
      const entryId = await createTestEntry(feedId, [userId]);
      await markEntryRead(userId, entryId);

      const counts = await getBulkEntryRelatedCounts(db, userId, [
        { subscriptionId: subId, type: "web" },
      ]);

      expect(counts.subscriptions).toEqual([{ id: subId, unread: 0 }]);
      expect(counts.tags).toEqual([]);
      expect(counts.uncategorized).toEqual({ unread: 0 });
    });
  });
});

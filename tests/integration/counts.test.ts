/**
 * Integration tests for the entry counts service.
 *
 * These verify the per-tag and uncategorized unread counts used by mutations
 * and SSE cache updates, in particular that each entry counts exactly once
 * (attribution is 1:1 via user_entries.subscription_id) and that they stay
 * consistent with listTags.
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";
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
import { getBulkEntryRelatedCounts } from "../../src/server/services/counts";
import {
  createTestEntry,
  createTestFeed,
  createTestSubscription,
  createTestTag,
  createTestUser,
} from "./helpers";

// ============================================================================
// Test Helpers
// ============================================================================

/**
 * Creates the two-subscription fixture: sub1 covers feedA, sub2 covers feedB,
 * with one unread entry in each feed. Attribution is 1:1 — each user_entries
 * row is stamped with exactly one subscription_id (formerly an entry could be
 * reachable through overlapping subscription_feeds rows and double-count).
 */
async function createOverlappingSubscriptions(userId: string) {
  const feedIdA = await createTestFeed({ url: "https://feed-a.com/rss" });
  const feedIdB = await createTestFeed({ url: "https://feed-b.com/rss" });
  const subId1 = await createTestSubscription(userId, feedIdA);
  const subId2 = await createTestSubscription(userId, feedIdB);

  const entryIdA = await createTestEntry(feedIdA, { userIds: [userId] });
  const entryIdB = await createTestEntry(feedIdB, { userIds: [userId] });

  return { feedIdA, feedIdB, subId1, subId2, entryIdA, entryIdB };
}

async function markEntryRead(userId: string, entryId: string): Promise<void> {
  await db
    .update(userEntries)
    .set({ read: true })
    .where(and(eq(userEntries.userId, userId), eq(userEntries.entryId, entryId)));
}

// ============================================================================
// Tests
// ============================================================================

describe("Entry counts service", () => {
  async function cleanup(): Promise<void> {
    await db.delete(userEntries);
    await db.delete(entries);
    await db.delete(subscriptionTags);
    await db.delete(tags);
    await db.delete(subscriptions);
    await db.delete(feeds);
    await db.delete(users);
  }

  beforeEach(cleanup);
  afterAll(cleanup);

  describe("global and tag counts", () => {
    it("returns the real global counts when no subscription is affected", async () => {
      // A caller patching these into the cache must not zero the user's
      // badges just because no affected entry was resolved (issue #956).
      const userId = await createTestUser();
      const feedId = await createTestFeed({ url: "https://mine.com/rss" });
      await createTestSubscription(userId, feedId);
      await createTestEntry(feedId, { userIds: [userId] }); // one real unread entry

      const counts = await getBulkEntryRelatedCounts(db, userId, []);

      expect(counts.all).toEqual({ unread: 1 });
      expect(counts.starred).toEqual({ unread: 0 });
    });

    it("does not double-count global unread for entries reachable through multiple subscriptions", async () => {
      // Regression test: the global "All Articles" count once inflated when
      // visible_entries emitted an entry once per matching junction row. With
      // 1:1 attribution the view emits one row per (user, entry), so the two
      // distinct unread entries count as exactly 2.
      const userId = await createTestUser();
      const { subId2 } = await createOverlappingSubscriptions(userId);

      const counts = await getBulkEntryRelatedCounts(db, userId, [{ subscriptionId: subId2 }]);

      expect(counts.all).toEqual({ unread: 2 });
    });

    it("excludes unread entries from unsubscribed feeds from global counts", async () => {
      // user_entries rows persist after unsubscribe (soft delete), but such
      // entries are not visible unless starred/saved. The global count must
      // exclude them.
      const userId = await createTestUser();
      const activeFeedId = await createTestFeed({ url: "https://active.com/rss" });
      const activeSubId = await createTestSubscription(userId, activeFeedId);
      await createTestEntry(activeFeedId, { userIds: [userId] });

      // A feed the user has unsubscribed from, with an unread (non-starred,
      // non-saved) entry whose user_entries row still exists.
      const goneFeedId = await createTestFeed({ url: "https://gone.com/rss" });
      const goneSubId = generateUuidv7();
      await db.insert(subscriptions).values({
        id: goneSubId,
        userId,
        feedId: goneFeedId,
        subscribedAt: new Date(),
        unsubscribedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      await createTestEntry(goneFeedId, { userIds: [userId] });

      const counts = await getBulkEntryRelatedCounts(db, userId, [{ subscriptionId: activeSubId }]);

      expect(counts.all).toEqual({ unread: 1 });
    });

    it("counts starred entries from unsubscribed feeds in global counts", async () => {
      // Starred entries are always visible, even from a feed the user has
      // unsubscribed from, so they must still count toward All Articles and
      // Starred.
      const userId = await createTestUser();
      const goneFeedId = await createTestFeed({ url: "https://gone-starred.com/rss" });
      const goneSubId = generateUuidv7();
      await db.insert(subscriptions).values({
        id: goneSubId,
        userId,
        feedId: goneFeedId,
        subscribedAt: new Date(),
        unsubscribedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      const starredEntryId = await createTestEntry(goneFeedId);
      await db.insert(userEntries).values({
        userId,
        entryId: starredEntryId,
        read: false,
        starred: true,
      });

      const counts = await getBulkEntryRelatedCounts(db, userId, [{ subscriptionId: goneSubId }]);

      expect(counts.all).toEqual({ unread: 1 });
      expect(counts.starred).toEqual({ unread: 1 });
    });

    it("does not count other users' unread entries in tag counts", async () => {
      const userId = await createTestUser({ emailPrefix: "user-a" });
      const otherUserId = await createTestUser({ emailPrefix: "user-b" });

      const feedId = await createTestFeed({ url: "https://shared.com/rss" });
      const subId = await createTestSubscription(userId, feedId);
      await createTestSubscription(otherUserId, feedId);
      const tagId = await createTestTag(userId, { name: "Mine", subscriptionIds: [subId] });

      await createTestEntry(feedId, { userIds: [userId, otherUserId] });
      await createTestEntry(feedId, { userIds: [otherUserId] });

      const counts = await getBulkEntryRelatedCounts(db, userId, [{ subscriptionId: subId }]);

      expect(counts.tags).toEqual([{ id: tagId, unread: 1 }]);
    });
  });

  describe("getBulkEntryRelatedCounts", () => {
    it("deduplicates tag counts for entries reachable through multiple subscriptions", async () => {
      const userId = await createTestUser();
      const { subId1, subId2 } = await createOverlappingSubscriptions(userId);
      const tagId = await createTestTag(userId, {
        name: "Tech",
        subscriptionIds: [subId1, subId2],
      });

      const counts = await getBulkEntryRelatedCounts(db, userId, [{ subscriptionId: subId1 }]);

      expect(counts.tags).toEqual([{ id: tagId, unread: 2 }]);
    });

    it("deduplicates the uncategorized count for entries reachable through multiple subscriptions", async () => {
      const userId = await createTestUser();
      const { subId1 } = await createOverlappingSubscriptions(userId);

      const counts = await getBulkEntryRelatedCounts(db, userId, [{ subscriptionId: subId1 }]);

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
      const feedId = await createTestFeed({ url: "https://events.com/rss" });
      const subId = await createTestSubscription(userId, feedId);
      const tagId = await createTestTag(userId, { name: "Events", subscriptionIds: [subId] });
      const entryId = await createTestEntry(feedId, { userIds: [userId] });
      await markEntryRead(userId, entryId);

      const counts = await getBulkEntryRelatedCounts(db, userId, [{ subscriptionId: subId }]);

      expect(counts.all).toEqual({ unread: 0 });
      expect(counts.subscriptions).toEqual([{ id: subId, unread: 0, tagIds: [tagId] }]);
      expect(counts.tags).toEqual([{ id: tagId, unread: 0 }]);
    });

    it("returns unread 0 for the drained subscription while other counts stay correct", async () => {
      // Two tagged subscriptions; only one is drained. The drained one must be
      // zero-filled while the shared tag keeps counting the other's entries.
      const userId = await createTestUser();
      const feedIdA = await createTestFeed({ url: "https://drained.com/rss" });
      const feedIdB = await createTestFeed({ url: "https://active.com/rss" });
      const subIdA = await createTestSubscription(userId, feedIdA);
      const subIdB = await createTestSubscription(userId, feedIdB);
      const tagId = await createTestTag(userId, {
        name: "Mixed",
        subscriptionIds: [subIdA, subIdB],
      });
      const entryIdA = await createTestEntry(feedIdA, { userIds: [userId] });
      await createTestEntry(feedIdB, { userIds: [userId] });
      await markEntryRead(userId, entryIdA);

      const counts = await getBulkEntryRelatedCounts(db, userId, [{ subscriptionId: subIdA }]);

      expect(counts.all).toEqual({ unread: 1 });
      expect(counts.subscriptions).toEqual([{ id: subIdA, unread: 0, tagIds: [tagId] }]);
      expect(counts.tags).toEqual([{ id: tagId, unread: 1 }]);
    });

    it("returns unread 0 for an uncategorized subscription drained of unread entries", async () => {
      const userId = await createTestUser();
      const feedId = await createTestFeed({ url: "https://uncategorized.com/rss" });
      const subId = await createTestSubscription(userId, feedId);
      const entryId = await createTestEntry(feedId, { userIds: [userId] });
      await markEntryRead(userId, entryId);

      const counts = await getBulkEntryRelatedCounts(db, userId, [{ subscriptionId: subId }]);

      expect(counts.subscriptions).toEqual([{ id: subId, unread: 0, tagIds: [] }]);
      expect(counts.tags).toEqual([]);
      expect(counts.uncategorized).toEqual({ unread: 0 });
    });
  });
});

/**
 * Integration tests for the denormalized user_entries.subscription_id and
 * user_entries.is_spam columns (issue #1117, migration 0086).
 *
 * These columns are INFORMATIONAL during the transition — entry visibility is
 * still resolved through the subscription_feeds junction — but every write
 * path must keep them consistent with what the junction resolves, because a
 * later release flips visibility (and unread counters) onto them:
 *
 * - Bulk insert paths (feed fanout, subscribe-time populate) set them inline.
 * - Single-row paths (email ingest, saved articles, tests/seeds) omit them and
 *   the user_entries_fill_denormalized BEFORE INSERT trigger fills them.
 * - The feed-merge job re-stamps rows from the old subscription to the survivor.
 *
 * The "reconciliation" tests at the bottom encode the exact query used to
 * verify prod before the visibility flip: every row's stamped subscription_id
 * must equal the junction-derived preferred subscription.
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { eq, and, sql } from "drizzle-orm";
import { db } from "../../src/server/db";
import {
  users,
  feeds,
  entries,
  subscriptions,
  subscriptionFeeds,
  userEntries,
  jobs,
} from "../../src/server/db/schema";
import { generateUuidv7 } from "../../src/lib/uuidv7";
import { createUserEntriesForFeed } from "../../src/server/feed/entry-processor";
import { migrateSubscriptionsToExistingFeed } from "../../src/server/jobs/handlers";
import { createSubscription } from "../../src/server/services/subscriptions";

// ============================================================================
// Test Helpers
// ============================================================================

async function createTestUser(prefix = "sub-id-user"): Promise<string> {
  const userId = generateUuidv7();
  await db.insert(users).values({
    id: userId,
    email: `${prefix}-${userId}@test.com`,
    passwordHash: "test-hash",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return userId;
}

async function createTestFeed(options: {
  url?: string;
  type?: "web" | "email" | "saved";
  lastEntriesUpdatedAt?: Date | null;
  /** Required for email/saved feeds (feed_type_user_id check constraint). */
  userId?: string;
}): Promise<string> {
  const feedId = generateUuidv7();
  const now = new Date();
  await db.insert(feeds).values({
    id: feedId,
    type: options.type ?? "web",
    url: options.url ?? `https://example.com/feed-${feedId}.xml`,
    userId: options.userId ?? null,
    title: `Test Feed ${feedId}`,
    lastEntriesUpdatedAt: options.lastEntriesUpdatedAt ?? null,
    createdAt: now,
    updatedAt: now,
  });
  return feedId;
}

async function createTestSubscription(
  userId: string,
  feedId: string,
  options?: { previousFeedIds?: string[]; unsubscribedAt?: Date | null }
): Promise<string> {
  const subscriptionId = generateUuidv7();
  await db.insert(subscriptions).values({
    id: subscriptionId,
    userId,
    feedId,
    subscribedAt: new Date(),
    unsubscribedAt: options?.unsubscribedAt ?? null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const allFeedIds = [feedId, ...(options?.previousFeedIds ?? [])];
  await db
    .insert(subscriptionFeeds)
    .values(allFeedIds.map((fId) => ({ subscriptionId, feedId: fId, userId })))
    .onConflictDoNothing();
  return subscriptionId;
}

async function createTestEntry(
  feedId: string,
  options: { isSpam?: boolean; lastSeenAt?: Date | null; type?: "web" | "email" | "saved" } = {}
): Promise<string> {
  const entryId = generateUuidv7();
  const now = new Date();
  const type = options.type ?? "web";
  await db.insert(entries).values({
    id: entryId,
    feedId,
    type,
    guid: `guid-${entryId}`,
    title: `Entry ${entryId}`,
    contentHash: `hash-${entryId}`,
    isSpam: options.isSpam ?? false,
    fetchedAt: now,
    // last_seen_at is only valid on fetched (web) entries
    // (entries_last_seen_only_fetched check constraint).
    lastSeenAt: type === "web" ? (options.lastSeenAt ?? now) : null,
    createdAt: now,
    updatedAt: now,
  });
  return entryId;
}

async function getUserEntry(userId: string, entryId: string) {
  const [row] = await db
    .select({
      subscriptionId: userEntries.subscriptionId,
      isSpam: userEntries.isSpam,
      publishedOrFetchedAt: userEntries.publishedOrFetchedAt,
    })
    .from(userEntries)
    .where(and(eq(userEntries.userId, userId), eq(userEntries.entryId, entryId)))
    .limit(1);
  return row;
}

/**
 * The reconciliation query: rows whose stamped subscription_id differs from the
 * junction-derived preferred subscription (active first, then direct feed
 * match, then most recent). This is the check to run against production before
 * flipping visibility onto the stamped column. Zero = consistent.
 */
async function countStampMismatches(): Promise<number> {
  const result = await db.execute(sql`
    SELECT count(*)::int AS mismatches
    FROM user_entries ue
    JOIN entries e ON e.id = ue.entry_id
    WHERE ue.subscription_id IS DISTINCT FROM (
      SELECT sf.subscription_id
      FROM subscription_feeds sf
      JOIN subscriptions s ON s.id = sf.subscription_id
      WHERE sf.user_id = ue.user_id
        AND sf.feed_id = e.feed_id
      ORDER BY (s.unsubscribed_at IS NULL) DESC,
               (s.feed_id = e.feed_id) DESC,
               s.subscribed_at DESC,
               s.id DESC
      LIMIT 1
    )
  `);
  return (result.rows[0] as { mismatches: number }).mismatches;
}

async function cleanupTables() {
  await db.delete(userEntries);
  await db.delete(entries);
  await db.delete(subscriptionFeeds);
  await db.delete(subscriptions);
  await db.delete(jobs);
  await db.delete(feeds);
  await db.delete(users);
}

// ============================================================================
// Tests
// ============================================================================

describe("user_entries.subscription_id / is_spam denormalization", () => {
  beforeEach(cleanupTables);
  afterAll(cleanupTables);

  describe("fill trigger (single-row insert paths)", () => {
    it("fills subscription_id, is_spam, and sort key when omitted", async () => {
      const userId = await createTestUser();
      // Email feed: is_spam=true is only valid on email entries
      // (entries_spam_only_email check constraint).
      const feedId = await createTestFeed({ type: "email", userId });
      const subscriptionId = await createTestSubscription(userId, feedId);
      const entryId = await createTestEntry(feedId, { isSpam: true, type: "email" });

      // Insert the way email ingest / saved articles / seeds do: identity only.
      await db.insert(userEntries).values({ userId, entryId });

      const row = await getUserEntry(userId, entryId);
      expect(row.subscriptionId).toBe(subscriptionId);
      expect(row.isSpam).toBe(true);
      expect(row.publishedOrFetchedAt).not.toBeNull();
    });

    it("leaves subscription_id NULL for entries in a feed with no subscription (saved articles)", async () => {
      const userId = await createTestUser();
      // Saved-articles feed: per-user, no subscription row.
      const feedId = await createTestFeed({ type: "saved", userId });
      const entryId = await createTestEntry(feedId, { type: "saved" });

      await db.insert(userEntries).values({ userId, entryId });

      const row = await getUserEntry(userId, entryId);
      expect(row.subscriptionId).toBeNull();
      expect(row.isSpam).toBe(false);
    });

    it("finds the subscription even when it is unsubscribed", async () => {
      // Attribution is to the (user, feed) subscription whether or not it is
      // active — visibility rules, not attribution, decide what the user sees.
      const userId = await createTestUser();
      const feedId = await createTestFeed({});
      const subscriptionId = await createTestSubscription(userId, feedId, {
        unsubscribedAt: new Date(),
      });
      const entryId = await createTestEntry(feedId);

      await db.insert(userEntries).values({ userId, entryId });

      const row = await getUserEntry(userId, entryId);
      expect(row.subscriptionId).toBe(subscriptionId);
    });

    it("does not override explicitly provided values", async () => {
      const userId = await createTestUser();
      const feedId = await createTestFeed({});
      await createTestSubscription(userId, feedId);
      const otherFeedId = await createTestFeed({});
      const otherSubscriptionId = await createTestSubscription(userId, otherFeedId);
      const entryId = await createTestEntry(feedId, { isSpam: false });

      await db.insert(userEntries).values({
        userId,
        entryId,
        subscriptionId: otherSubscriptionId,
        isSpam: true,
      });

      const row = await getUserEntry(userId, entryId);
      expect(row.subscriptionId).toBe(otherSubscriptionId);
      expect(row.isSpam).toBe(true);
    });
  });

  describe("feed fanout (createUserEntriesForFeed)", () => {
    it("stamps each subscriber's own subscription", async () => {
      const feedId = await createTestFeed({});
      const user1 = await createTestUser("fanout-1");
      const user2 = await createTestUser("fanout-2");
      const sub1 = await createTestSubscription(user1, feedId);
      const sub2 = await createTestSubscription(user2, feedId);
      const entryId = await createTestEntry(feedId);

      await createUserEntriesForFeed(feedId, [entryId]);

      const row1 = await getUserEntry(user1, entryId);
      const row2 = await getUserEntry(user2, entryId);
      expect(row1.subscriptionId).toBe(sub1);
      expect(row2.subscriptionId).toBe(sub2);
      expect(row1.isSpam).toBe(false);
      expect(await countStampMismatches()).toBe(0);
    });

    it("copies is_spam from the entry", async () => {
      const userId = await createTestUser("fanout-spam");
      // Email feed (user-owned) so the spam entry passes entries_spam_only_email.
      const feedId = await createTestFeed({ type: "email", userId });
      await createTestSubscription(userId, feedId);
      const spamEntryId = await createTestEntry(feedId, { isSpam: true, type: "email" });
      const hamEntryId = await createTestEntry(feedId, { type: "email" });

      await createUserEntriesForFeed(feedId, [spamEntryId, hamEntryId]);

      expect((await getUserEntry(userId, spamEntryId)).isSpam).toBe(true);
      expect((await getUserEntry(userId, hamEntryId)).isSpam).toBe(false);
    });
  });

  describe("subscribe-time populate (createSubscription)", () => {
    it("stamps the new subscription on the populated entries", async () => {
      const userId = await createTestUser("subscribe");
      const now = new Date();
      const url = `https://example.com/populate-${generateUuidv7()}.xml`;
      const feedId = await createTestFeed({ url, lastEntriesUpdatedAt: now });
      const entryId = await createTestEntry(feedId, { lastSeenAt: now });

      const result = await createSubscription(db, userId, { url });

      const row = await getUserEntry(userId, entryId);
      expect(row.subscriptionId).toBe(result.subscriptionId);
      expect(row.isSpam).toBe(false);
      expect(await countStampMismatches()).toBe(0);
    });
  });

  describe("feed merge re-stamp (migrateSubscriptionsToExistingFeed)", () => {
    it("re-stamps old-feed entries to the newly created subscription", async () => {
      const userId = await createTestUser("merge-new");
      const oldFeedId = await createTestFeed({ url: "https://old.example.com/feed.xml" });
      const newFeedId = await createTestFeed({ url: "https://new.example.com/feed.xml" });
      const oldSubId = await createTestSubscription(userId, oldFeedId);
      const entryId = await createTestEntry(oldFeedId);
      await db.insert(userEntries).values({ userId, entryId });

      // Sanity: stamped with the old subscription before the merge.
      expect((await getUserEntry(userId, entryId)).subscriptionId).toBe(oldSubId);

      const [oldFeed] = await db.select().from(feeds).where(eq(feeds.id, oldFeedId));
      const [newFeed] = await db.select().from(feeds).where(eq(feeds.id, newFeedId));
      await migrateSubscriptionsToExistingFeed(oldFeed, newFeed);

      const [newSub] = await db
        .select({ id: subscriptions.id })
        .from(subscriptions)
        .where(and(eq(subscriptions.userId, userId), eq(subscriptions.feedId, newFeedId)));
      const row = await getUserEntry(userId, entryId);
      expect(row.subscriptionId).toBe(newSub.id);
      expect(row.subscriptionId).not.toBe(oldSubId);
      expect(await countStampMismatches()).toBe(0);
    });

    it("re-stamps old-feed entries to the user's existing subscription to the target feed", async () => {
      const userId = await createTestUser("merge-existing");
      const oldFeedId = await createTestFeed({ url: "https://old2.example.com/feed.xml" });
      const newFeedId = await createTestFeed({ url: "https://new2.example.com/feed.xml" });
      const oldSubId = await createTestSubscription(userId, oldFeedId);
      const existingNewSubId = await createTestSubscription(userId, newFeedId);

      const oldEntryId = await createTestEntry(oldFeedId);
      const newEntryId = await createTestEntry(newFeedId);
      await db.insert(userEntries).values({ userId, entryId: oldEntryId });
      await db.insert(userEntries).values({ userId, entryId: newEntryId });

      const [oldFeed] = await db.select().from(feeds).where(eq(feeds.id, oldFeedId));
      const [newFeed] = await db.select().from(feeds).where(eq(feeds.id, newFeedId));
      await migrateSubscriptionsToExistingFeed(oldFeed, newFeed);

      // Old-feed entry moved to the surviving subscription; new-feed entry unchanged.
      expect((await getUserEntry(userId, oldEntryId)).subscriptionId).toBe(existingNewSubId);
      expect((await getUserEntry(userId, newEntryId)).subscriptionId).toBe(existingNewSubId);

      // Old subscription is unsubscribed and owns no rows anymore.
      const [oldSub] = await db
        .select({ unsubscribedAt: subscriptions.unsubscribedAt })
        .from(subscriptions)
        .where(eq(subscriptions.id, oldSubId));
      expect(oldSub.unsubscribedAt).not.toBeNull();
      const orphaned = await db
        .select({ entryId: userEntries.entryId })
        .from(userEntries)
        .where(eq(userEntries.subscriptionId, oldSubId));
      expect(orphaned).toHaveLength(0);
      expect(await countStampMismatches()).toBe(0);
    });

    it("re-stamps every affected user in a multi-subscriber merge", async () => {
      const oldFeedId = await createTestFeed({ url: "https://old3.example.com/feed.xml" });
      const newFeedId = await createTestFeed({ url: "https://new3.example.com/feed.xml" });
      const userA = await createTestUser("merge-a");
      const userB = await createTestUser("merge-b");
      await createTestSubscription(userA, oldFeedId);
      await createTestSubscription(userB, oldFeedId);
      const existingBSub = await createTestSubscription(userB, newFeedId);

      const entryId = await createTestEntry(oldFeedId);
      await db.insert(userEntries).values({ userId: userA, entryId });
      await db.insert(userEntries).values({ userId: userB, entryId });

      const [oldFeed] = await db.select().from(feeds).where(eq(feeds.id, oldFeedId));
      const [newFeed] = await db.select().from(feeds).where(eq(feeds.id, newFeedId));
      await migrateSubscriptionsToExistingFeed(oldFeed, newFeed);

      const [newASub] = await db
        .select({ id: subscriptions.id })
        .from(subscriptions)
        .where(and(eq(subscriptions.userId, userA), eq(subscriptions.feedId, newFeedId)));
      expect((await getUserEntry(userA, entryId)).subscriptionId).toBe(newASub.id);
      expect((await getUserEntry(userB, entryId)).subscriptionId).toBe(existingBSub);
      expect(await countStampMismatches()).toBe(0);
    });
  });
});

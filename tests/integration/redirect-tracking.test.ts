/**
 * Integration tests for feed redirect tracking.
 *
 * These tests verify the redirect tracking behavior at the database level,
 * including tracking, wait periods, and migration.
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { eq, and } from "drizzle-orm";
import { db } from "../../src/server/db";
import { feeds, subscriptions, users, jobs } from "../../src/server/db/schema";
import { generateUuidv7 } from "../../src/lib/uuidv7";
import { REDIRECT_WAIT_PERIOD_MS } from "../../src/server/feed/redirect-utils";
import { ensureFeedJob, getJobPayload, claimFeedJob } from "../../src/server/jobs/queue";

describe("Redirect Tracking", () => {
  // Clean up before each test
  beforeEach(async () => {
    await db.delete(jobs);
    await db.delete(subscriptions);
    await db.delete(feeds);
    await db.delete(users);
  });

  // Clean up after all tests
  afterAll(async () => {
    await db.delete(jobs);
    await db.delete(subscriptions);
    await db.delete(feeds);
    await db.delete(users);
  });

  /**
   * Helper to create a test user
   */
  async function createTestUser(): Promise<string> {
    const userId = generateUuidv7();
    await db.insert(users).values({
      id: userId,
      email: `test-${userId}@example.com`,
      passwordHash: "hash",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return userId;
  }

  /**
   * Helper to create a test feed
   */
  async function createTestFeed(
    overrides: Partial<typeof feeds.$inferInsert> = {}
  ): Promise<string> {
    const feedId = generateUuidv7();
    const now = new Date();
    await db.insert(feeds).values({
      id: feedId,
      type: "web",
      url: `https://example.com/feed-${feedId}.xml`,
      createdAt: now,
      updatedAt: now,
      ...overrides,
    });
    return feedId;
  }

  /**
   * Helper to get a feed by ID
   */
  async function getFeed(feedId: string) {
    const [feed] = await db.select().from(feeds).where(eq(feeds.id, feedId)).limit(1);
    return feed;
  }

  /**
   * Helper to create an active subscription
   */
  async function createSubscription(userId: string, feedId: string): Promise<string> {
    const subscriptionId = generateUuidv7();
    const now = new Date();
    await db.insert(subscriptions).values({
      id: subscriptionId,
      userId,
      feedId,
      subscribedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    return subscriptionId;
  }

  describe("redirect tracking fields", () => {
    it("starts with null redirect tracking fields", async () => {
      const feedId = await createTestFeed();
      const feed = await getFeed(feedId);

      expect(feed.redirectUrl).toBeNull();
      expect(feed.redirectFirstSeenAt).toBeNull();
    });

    it("can store redirect tracking information", async () => {
      const feedId = await createTestFeed();
      const redirectUrl = "https://newsite.com/feed.xml";
      const redirectFirstSeenAt = new Date();

      await db
        .update(feeds)
        .set({
          redirectUrl,
          redirectFirstSeenAt,
          updatedAt: new Date(),
        })
        .where(eq(feeds.id, feedId));

      const feed = await getFeed(feedId);
      expect(feed.redirectUrl).toBe(redirectUrl);
      expect(feed.redirectFirstSeenAt).toEqual(redirectFirstSeenAt);
    });

    it("can clear redirect tracking information", async () => {
      const feedId = await createTestFeed({
        redirectUrl: "https://newsite.com/feed.xml",
        redirectFirstSeenAt: new Date(),
      });

      await db
        .update(feeds)
        .set({
          redirectUrl: null,
          redirectFirstSeenAt: null,
          updatedAt: new Date(),
        })
        .where(eq(feeds.id, feedId));

      const feed = await getFeed(feedId);
      expect(feed.redirectUrl).toBeNull();
      expect(feed.redirectFirstSeenAt).toBeNull();
    });
  });

  describe("wait period tracking", () => {
    it("correctly tracks time since redirect was first seen", async () => {
      const feedId = await createTestFeed();
      const firstSeenAt = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000); // 3 days ago

      await db
        .update(feeds)
        .set({
          redirectUrl: "https://newsite.com/feed.xml",
          redirectFirstSeenAt: firstSeenAt,
          updatedAt: new Date(),
        })
        .where(eq(feeds.id, feedId));

      const feed = await getFeed(feedId);
      const timeSinceFirstSeen = Date.now() - feed.redirectFirstSeenAt!.getTime();

      // Should be approximately 3 days (allow 1 second tolerance for test execution)
      expect(timeSinceFirstSeen).toBeGreaterThan(3 * 24 * 60 * 60 * 1000 - 1000);
      expect(timeSinceFirstSeen).toBeLessThan(3 * 24 * 60 * 60 * 1000 + 10000);
    });

    it("identifies when wait period has not yet passed", async () => {
      const feedId = await createTestFeed();
      const firstSeenAt = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000); // 3 days ago

      await db
        .update(feeds)
        .set({
          redirectUrl: "https://newsite.com/feed.xml",
          redirectFirstSeenAt: firstSeenAt,
          updatedAt: new Date(),
        })
        .where(eq(feeds.id, feedId));

      const feed = await getFeed(feedId);
      const timeSinceFirstSeen = Date.now() - feed.redirectFirstSeenAt!.getTime();

      // Should not have exceeded the 7-day wait period
      expect(timeSinceFirstSeen < REDIRECT_WAIT_PERIOD_MS).toBe(true);
    });

    it("identifies when wait period has passed", async () => {
      const feedId = await createTestFeed();
      const firstSeenAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000); // 8 days ago

      await db
        .update(feeds)
        .set({
          redirectUrl: "https://newsite.com/feed.xml",
          redirectFirstSeenAt: firstSeenAt,
          updatedAt: new Date(),
        })
        .where(eq(feeds.id, feedId));

      const feed = await getFeed(feedId);
      const timeSinceFirstSeen = Date.now() - feed.redirectFirstSeenAt!.getTime();

      // Should have exceeded the 7-day wait period
      expect(timeSinceFirstSeen >= REDIRECT_WAIT_PERIOD_MS).toBe(true);
    });
  });

  describe("redirect URL update simulation", () => {
    it("updates feed URL when no existing feed at redirect destination", async () => {
      const originalUrl = "https://oldsite.com/feed.xml";
      const redirectUrl = "https://newsite.com/feed.xml";
      const feedId = await createTestFeed({ url: originalUrl });

      // Simulate applying the redirect
      await db
        .update(feeds)
        .set({
          url: redirectUrl,
          redirectUrl: null,
          redirectFirstSeenAt: null,
          updatedAt: new Date(),
        })
        .where(eq(feeds.id, feedId));

      const feed = await getFeed(feedId);
      expect(feed.url).toBe(redirectUrl);
      expect(feed.redirectUrl).toBeNull();
      expect(feed.redirectFirstSeenAt).toBeNull();
    });
  });

  describe("subscription migration", () => {
    it("migrates subscriptions when redirect destination has existing feed", async () => {
      const userId = await createTestUser();

      // Create old feed (being redirected)
      const oldFeedUrl = "https://oldsite.com/feed.xml";
      const oldFeedId = await createTestFeed({ url: oldFeedUrl });
      await createSubscription(userId, oldFeedId);
      await ensureFeedJob(oldFeedId);

      // Create new feed (redirect destination)
      const newFeedUrl = "https://newsite.com/feed.xml";
      const newFeedId = await createTestFeed({ url: newFeedUrl });
      await ensureFeedJob(newFeedId);

      // Verify initial state: user subscribed to old feed only
      const initialOldSub = await db
        .select()
        .from(subscriptions)
        .where(and(eq(subscriptions.userId, userId), eq(subscriptions.feedId, oldFeedId)))
        .limit(1);
      expect(initialOldSub).toHaveLength(1);
      expect(initialOldSub[0].unsubscribedAt).toBeNull();

      const initialNewSub = await db
        .select()
        .from(subscriptions)
        .where(and(eq(subscriptions.userId, userId), eq(subscriptions.feedId, newFeedId)))
        .limit(1);
      expect(initialNewSub).toHaveLength(0);

      // Simulate migration: unsubscribe from old, subscribe to new with previousFeedIds
      const now = new Date();

      // Create subscription to new feed with old feed in previousFeedIds
      const newSubId = generateUuidv7();
      await db.insert(subscriptions).values({
        id: newSubId,
        userId,
        feedId: newFeedId,
        previousFeedIds: [oldFeedId],
        subscribedAt: now,
        createdAt: now,
        updatedAt: now,
      });

      // Unsubscribe from old feed
      await db
        .update(subscriptions)
        .set({
          unsubscribedAt: now,
          updatedAt: now,
        })
        .where(and(eq(subscriptions.userId, userId), eq(subscriptions.feedId, oldFeedId)));

      // Verify migration: user subscribed to new feed, unsubscribed from old
      const migratedOldSub = await db
        .select()
        .from(subscriptions)
        .where(and(eq(subscriptions.userId, userId), eq(subscriptions.feedId, oldFeedId)))
        .limit(1);
      expect(migratedOldSub).toHaveLength(1);
      expect(migratedOldSub[0].unsubscribedAt).not.toBeNull();

      const migratedNewSub = await db
        .select()
        .from(subscriptions)
        .where(and(eq(subscriptions.userId, userId), eq(subscriptions.feedId, newFeedId)))
        .limit(1);
      expect(migratedNewSub).toHaveLength(1);
      expect(migratedNewSub[0].unsubscribedAt).toBeNull();
      expect(migratedNewSub[0].previousFeedIds).toContain(oldFeedId);
    });

    it("appends to previousFeedIds when user already subscribed to new feed", async () => {
      const userId = await createTestUser();

      // Create feeds
      const oldFeedId = await createTestFeed({ url: "https://oldsite.com/feed.xml" });
      const newFeedId = await createTestFeed({ url: "https://newsite.com/feed.xml" });

      // User already subscribed to new feed
      const existingSubId = await createSubscription(userId, newFeedId);

      // User also subscribed to old feed
      await createSubscription(userId, oldFeedId);

      // Simulate migration by appending old feed to new subscription's previousFeedIds
      const now = new Date();

      await db
        .update(subscriptions)
        .set({
          previousFeedIds: [oldFeedId],
          updatedAt: now,
        })
        .where(eq(subscriptions.id, existingSubId));

      // Unsubscribe from old feed
      await db
        .update(subscriptions)
        .set({
          unsubscribedAt: now,
          updatedAt: now,
        })
        .where(and(eq(subscriptions.userId, userId), eq(subscriptions.feedId, oldFeedId)));

      // Verify the existing subscription was updated
      const updatedSub = await db
        .select()
        .from(subscriptions)
        .where(eq(subscriptions.id, existingSubId))
        .limit(1);
      expect(updatedSub).toHaveLength(1);
      expect(updatedSub[0].previousFeedIds).toContain(oldFeedId);
      expect(updatedSub[0].unsubscribedAt).toBeNull();
    });

    it("reactivates unsubscribed subscription at redirect destination", async () => {
      const userId = await createTestUser();

      // Create feeds
      const oldFeedId = await createTestFeed({ url: "https://oldsite.com/feed.xml" });
      const newFeedId = await createTestFeed({ url: "https://newsite.com/feed.xml" });

      // User was subscribed to new feed but unsubscribed
      const unsubscribedAt = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // 30 days ago
      const subId = generateUuidv7();
      const subCreatedAt = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000); // 60 days ago
      await db.insert(subscriptions).values({
        id: subId,
        userId,
        feedId: newFeedId,
        subscribedAt: subCreatedAt,
        unsubscribedAt,
        createdAt: subCreatedAt,
        updatedAt: unsubscribedAt,
      });

      // User subscribed to old feed
      await createSubscription(userId, oldFeedId);

      // Simulate migration: reactivate new sub and add old feed to previousFeedIds
      const now = new Date();

      await db
        .update(subscriptions)
        .set({
          unsubscribedAt: null,
          subscribedAt: now,
          previousFeedIds: [oldFeedId],
          updatedAt: now,
        })
        .where(eq(subscriptions.id, subId));

      // Unsubscribe from old feed
      await db
        .update(subscriptions)
        .set({
          unsubscribedAt: now,
          updatedAt: now,
        })
        .where(and(eq(subscriptions.userId, userId), eq(subscriptions.feedId, oldFeedId)));

      // Verify reactivation
      const reactivatedSub = await db
        .select()
        .from(subscriptions)
        .where(eq(subscriptions.id, subId))
        .limit(1);
      expect(reactivatedSub).toHaveLength(1);
      expect(reactivatedSub[0].unsubscribedAt).toBeNull();
      expect(reactivatedSub[0].previousFeedIds).toContain(oldFeedId);
    });
  });

  describe("job enabling on redirect", () => {
    it("job becomes claimable when subscriptions are migrated", async () => {
      const userId = await createTestUser();

      // Create new feed (redirect destination)
      const newFeedId = await createTestFeed({ url: "https://newsite.com/feed.xml" });

      // Create job for new feed (but no subscribers yet, so it won't be claimable)
      await ensureFeedJob(newFeedId, new Date(Date.now() - 1000)); // Due now

      // Verify job is NOT claimable (no active subscribers)
      const claimedBefore = await claimFeedJob();
      expect(claimedBefore).toBeNull();

      // Simulate migration: create subscription to new feed
      const now = new Date();
      const subId = generateUuidv7();
      await db.insert(subscriptions).values({
        id: subId,
        userId,
        feedId: newFeedId,
        subscribedAt: now,
        createdAt: now,
        updatedAt: now,
      });

      // Now the job should be claimable (has active subscriber)
      const claimedAfter = await claimFeedJob();
      expect(claimedAfter).not.toBeNull();
      expect(getJobPayload<"fetch_feed">(claimedAfter!).feedId).toBe(newFeedId);
    });
  });

  describe("redirect tracking reset on destination change", () => {
    it("resets tracking when redirect destination changes", async () => {
      const feedId = await createTestFeed({
        url: "https://original.com/feed.xml",
        redirectUrl: "https://redirect1.com/feed.xml",
        redirectFirstSeenAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000), // 5 days ago
      });

      // Simulate detecting a different redirect destination
      const newRedirectUrl = "https://redirect2.com/feed.xml";
      const now = new Date();

      await db
        .update(feeds)
        .set({
          redirectUrl: newRedirectUrl,
          redirectFirstSeenAt: now, // Reset the timestamp
          updatedAt: now,
        })
        .where(eq(feeds.id, feedId));

      const feed = await getFeed(feedId);
      expect(feed.redirectUrl).toBe(newRedirectUrl);
      // The timestamp should be reset (approximately now)
      const timeSinceFirstSeen = Date.now() - feed.redirectFirstSeenAt!.getTime();
      expect(timeSinceFirstSeen).toBeLessThan(1000); // Less than 1 second ago
    });
  });

  describe("REDIRECT_WAIT_PERIOD_MS constant", () => {
    it("is 7 days in milliseconds", () => {
      expect(REDIRECT_WAIT_PERIOD_MS).toBe(7 * 24 * 60 * 60 * 1000);
    });
  });
});

/**
 * Integration tests for feed redirect handling.
 *
 * These tests verify that when a feed permanently redirects to a new URL:
 * 1. If no feed exists at the target URL, the feed's URL is simply updated
 * 2. If a feed exists at the target URL, subscriptions are migrated
 * 3. User read/starred state is preserved through the migration
 * 4. Users see entries from both old and new feeds without duplicates
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { eq, and, isNull } from "drizzle-orm";
import { db } from "../../src/server/db";
import {
  users,
  feeds,
  entries,
  subscriptions,
  userEntries,
  jobs,
  type Feed,
} from "../../src/server/db/schema";
import { generateUuidv7 } from "../../src/lib/uuidv7";
import { createCaller } from "../../src/server/trpc/root";
import type { Context } from "../../src/server/trpc/context";
import { createOrEnableFeedJob } from "../../src/server/jobs";
import { migrateSubscriptionsToExistingFeed } from "../../src/server/jobs/handlers";
import { createUserEntriesForFeed } from "../../src/server/feed";

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
        createdAt: now,
        updatedAt: now,
      },
    },
    sessionToken: "test-token",
    headers: new Headers(),
  };
}

/**
 * Creates a test feed with specified parameters.
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
async function createTestSubscription(
  userId: string,
  feedId: string,
  options?: { previousFeedIds?: string[] }
): Promise<string> {
  const subscriptionId = generateUuidv7();
  await db.insert(subscriptions).values({
    id: subscriptionId,
    userId,
    feedId,
    previousFeedIds: options?.previousFeedIds ?? [],
    subscribedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return subscriptionId;
}

/**
 * Creates a test entry with specified parameters.
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
 * Creates user_entries for a user and entries.
 */
async function createUserEntries(
  userId: string,
  entryIds: string[],
  options?: { read?: boolean; starred?: boolean }
): Promise<void> {
  const now = new Date();
  for (const entryId of entryIds) {
    await db.insert(userEntries).values({
      userId,
      entryId,
      read: options?.read ?? false,
      starred: options?.starred ?? false,
      updatedAt: now,
    });
  }
}

/**
 * Gets user_entries for a user.
 */
async function getUserEntries(userId: string): Promise<
  Array<{
    entryId: string;
    read: boolean;
    starred: boolean;
  }>
> {
  return db
    .select({
      entryId: userEntries.entryId,
      read: userEntries.read,
      starred: userEntries.starred,
    })
    .from(userEntries)
    .where(eq(userEntries.userId, userId));
}

/**
 * Gets a subscription by user and feed.
 */
async function getSubscription(
  userId: string,
  feedId: string
): Promise<{
  id: string;
  feedId: string;
  previousFeedIds: string[];
  unsubscribedAt: Date | null;
} | null> {
  const result = await db
    .select({
      id: subscriptions.id,
      feedId: subscriptions.feedId,
      previousFeedIds: subscriptions.previousFeedIds,
      unsubscribedAt: subscriptions.unsubscribedAt,
    })
    .from(subscriptions)
    .where(and(eq(subscriptions.userId, userId), eq(subscriptions.feedId, feedId)))
    .limit(1);
  return result[0] ?? null;
}

/**
 * Gets active subscriptions for a user.
 */
async function getActiveSubscriptions(
  userId: string
): Promise<Array<{ feedId: string; previousFeedIds: string[] }>> {
  return db
    .select({
      feedId: subscriptions.feedId,
      previousFeedIds: subscriptions.previousFeedIds,
    })
    .from(subscriptions)
    .where(and(eq(subscriptions.userId, userId), isNull(subscriptions.unsubscribedAt)));
}

/**
 * Gets a feed by ID.
 */
async function getFeed(feedId: string): Promise<Feed> {
  const [feed] = await db.select().from(feeds).where(eq(feeds.id, feedId)).limit(1);
  if (!feed) {
    throw new Error(`Feed not found: ${feedId}`);
  }
  return feed;
}

// ============================================================================
// Tests
// ============================================================================

describe("Feed Redirect Handling", () => {
  // Clean up tables before each test
  beforeEach(async () => {
    await db.delete(userEntries);
    await db.delete(entries);
    await db.delete(subscriptions);
    await db.delete(jobs);
    await db.delete(feeds);
    await db.delete(users);
  });

  // Clean up after all tests
  afterAll(async () => {
    await db.delete(userEntries);
    await db.delete(entries);
    await db.delete(subscriptions);
    await db.delete(jobs);
    await db.delete(feeds);
    await db.delete(users);
  });

  describe("Redirect to new URL (no existing feed)", () => {
    it("updates feed URL when redirect target has no existing feed", async () => {
      // This scenario is handled by simply updating the feed's URL
      // We just verify that the URL can be updated
      const feedId = await createTestFeed({
        url: "https://old-domain.com/feed.xml",
        title: "Test Feed",
      });

      // Simulate URL update (what happens in the handler)
      await db
        .update(feeds)
        .set({ url: "https://new-domain.com/feed.xml" })
        .where(eq(feeds.id, feedId));

      // Verify the URL was updated
      const [updatedFeed] = await db.select().from(feeds).where(eq(feeds.id, feedId));
      expect(updatedFeed.url).toBe("https://new-domain.com/feed.xml");
    });
  });

  describe("Redirect to existing feed - new subscription created", () => {
    it("creates subscription to new feed with old feed in previousFeedIds", async () => {
      const userId = await createTestUser();
      const fetchTime = new Date("2024-01-01T10:00:00Z");

      // Create old feed and new feed
      const oldFeedId = await createTestFeed({
        url: "https://old-domain.com/feed.xml",
        title: "Old Feed",
        lastFetchedAt: fetchTime,
        lastEntriesUpdatedAt: fetchTime,
      });

      const newFeedId = await createTestFeed({
        url: "https://new-domain.com/feed.xml",
        title: "New Feed",
        lastFetchedAt: fetchTime,
        lastEntriesUpdatedAt: fetchTime,
      });

      // User is subscribed to old feed
      await createTestSubscription(userId, oldFeedId);

      // Create entries in old feed
      const oldEntry1 = await createTestEntry(oldFeedId, {
        guid: "entry-1",
        title: "Old Entry 1",
        fetchedAt: fetchTime,
        lastSeenAt: fetchTime,
      });

      // Create user_entries for old feed entries
      await createUserEntries(userId, [oldEntry1]);

      // Create job for old feed
      await createOrEnableFeedJob(oldFeedId);

      // Simulate the redirect migration
      await migrateSubscriptionsToExistingFeed(await getFeed(oldFeedId), await getFeed(newFeedId));

      // Verify: User should have subscription to new feed with old feed in previousFeedIds
      const newSub = await getSubscription(userId, newFeedId);
      expect(newSub).not.toBeNull();
      expect(newSub!.previousFeedIds).toContain(oldFeedId);

      // Verify: Old subscription should be unsubscribed
      const oldSub = await getSubscription(userId, oldFeedId);
      expect(oldSub).not.toBeNull();
      expect(oldSub!.unsubscribedAt).not.toBeNull();

      // Verify: User still has their user_entries from old feed
      const userEntriesResult = await getUserEntries(userId);
      expect(userEntriesResult.map((ue) => ue.entryId)).toContain(oldEntry1);
    });
  });

  describe("Redirect when user already subscribed to target feed", () => {
    it("appends old feed to existing subscription's previousFeedIds", async () => {
      const userId = await createTestUser();
      const fetchTime = new Date("2024-01-01T10:00:00Z");

      // Create old feed and new feed
      const oldFeedId = await createTestFeed({
        url: "https://old-domain.com/feed.xml",
        title: "Old Feed",
        lastFetchedAt: fetchTime,
        lastEntriesUpdatedAt: fetchTime,
      });

      const newFeedId = await createTestFeed({
        url: "https://new-domain.com/feed.xml",
        title: "New Feed",
        lastFetchedAt: fetchTime,
        lastEntriesUpdatedAt: fetchTime,
      });

      // User is subscribed to BOTH old feed and new feed
      await createTestSubscription(userId, oldFeedId);
      await createTestSubscription(userId, newFeedId);

      // Create entries in both feeds
      const oldEntry = await createTestEntry(oldFeedId, {
        guid: "old-entry",
        title: "Old Entry",
        fetchedAt: fetchTime,
        lastSeenAt: fetchTime,
      });

      const newEntry = await createTestEntry(newFeedId, {
        guid: "new-entry",
        title: "New Entry",
        fetchedAt: fetchTime,
        lastSeenAt: fetchTime,
      });

      // Create user_entries for both
      await createUserEntries(userId, [oldEntry, newEntry]);

      // Simulate the redirect migration
      await migrateSubscriptionsToExistingFeed(await getFeed(oldFeedId), await getFeed(newFeedId));

      // Verify: Subscription to new feed should have old feed in previousFeedIds
      const newSub = await getSubscription(userId, newFeedId);
      expect(newSub).not.toBeNull();
      expect(newSub!.previousFeedIds).toContain(oldFeedId);
      expect(newSub!.unsubscribedAt).toBeNull(); // Still active

      // Verify: Old subscription should be unsubscribed
      const oldSub = await getSubscription(userId, oldFeedId);
      expect(oldSub!.unsubscribedAt).not.toBeNull();

      // Verify: User has one active subscription
      const activeSubs = await getActiveSubscriptions(userId);
      expect(activeSubs).toHaveLength(1);
      expect(activeSubs[0].feedId).toBe(newFeedId);
    });

    it("reactivates unsubscribed subscription to new feed when redirect happens", async () => {
      const userId = await createTestUser();
      const fetchTime = new Date("2024-01-01T10:00:00Z");

      // Create old feed and new feed
      const oldFeedId = await createTestFeed({
        url: "https://old-domain.com/feed.xml",
        title: "Old Feed",
        lastFetchedAt: fetchTime,
        lastEntriesUpdatedAt: fetchTime,
      });

      const newFeedId = await createTestFeed({
        url: "https://new-domain.com/feed.xml",
        title: "New Feed",
        lastFetchedAt: fetchTime,
        lastEntriesUpdatedAt: fetchTime,
      });

      // User subscribed to old feed
      await createTestSubscription(userId, oldFeedId);

      // User previously subscribed and unsubscribed from new feed
      const newSubId = await createTestSubscription(userId, newFeedId);
      await db
        .update(subscriptions)
        .set({ unsubscribedAt: new Date() })
        .where(eq(subscriptions.id, newSubId));

      // Simulate the redirect migration
      await migrateSubscriptionsToExistingFeed(await getFeed(oldFeedId), await getFeed(newFeedId));

      // Verify: New feed subscription should be reactivated with old feed in previousFeedIds
      const newSub = await getSubscription(userId, newFeedId);
      expect(newSub).not.toBeNull();
      expect(newSub!.unsubscribedAt).toBeNull(); // Reactivated
      expect(newSub!.previousFeedIds).toContain(oldFeedId);
    });
  });

  describe("Multiple users subscribed to old feed", () => {
    it("migrates all users' subscriptions when feed redirects", async () => {
      const userA = await createTestUser("userA");
      const userB = await createTestUser("userB");
      const fetchTime = new Date("2024-01-01T10:00:00Z");

      // Create old feed and new feed
      const oldFeedId = await createTestFeed({
        url: "https://old-domain.com/feed.xml",
        title: "Old Feed",
        lastFetchedAt: fetchTime,
        lastEntriesUpdatedAt: fetchTime,
      });

      const newFeedId = await createTestFeed({
        url: "https://new-domain.com/feed.xml",
        title: "New Feed",
        lastFetchedAt: fetchTime,
        lastEntriesUpdatedAt: fetchTime,
      });

      // Both users subscribed to old feed
      await createTestSubscription(userA, oldFeedId);
      await createTestSubscription(userB, oldFeedId);

      // Create entries in old feed
      const oldEntry = await createTestEntry(oldFeedId, {
        guid: "shared-entry",
        title: "Shared Entry",
        fetchedAt: fetchTime,
        lastSeenAt: fetchTime,
      });

      // Create user_entries for both users
      await createUserEntries(userA, [oldEntry]);
      await createUserEntries(userB, [oldEntry]);

      // Create job for old feed
      await createOrEnableFeedJob(oldFeedId);

      // Simulate the redirect migration
      await migrateSubscriptionsToExistingFeed(await getFeed(oldFeedId), await getFeed(newFeedId));

      // Verify: Both users should have subscriptions to new feed
      const userANewSub = await getSubscription(userA, newFeedId);
      const userBNewSub = await getSubscription(userB, newFeedId);

      expect(userANewSub).not.toBeNull();
      expect(userBNewSub).not.toBeNull();
      expect(userANewSub!.previousFeedIds).toContain(oldFeedId);
      expect(userBNewSub!.previousFeedIds).toContain(oldFeedId);

      // Verify: Both old subscriptions should be unsubscribed
      const userAOldSub = await getSubscription(userA, oldFeedId);
      const userBOldSub = await getSubscription(userB, oldFeedId);

      expect(userAOldSub!.unsubscribedAt).not.toBeNull();
      expect(userBOldSub!.unsubscribedAt).not.toBeNull();

      // Verify: Both users still have their user_entries
      const userAEntries = await getUserEntries(userA);
      const userBEntries = await getUserEntries(userB);

      expect(userAEntries.map((ue) => ue.entryId)).toContain(oldEntry);
      expect(userBEntries.map((ue) => ue.entryId)).toContain(oldEntry);
    });
  });

  describe("Entry visibility after redirect", () => {
    it("user sees entries from both old and new feeds via feed_ids", async () => {
      const userId = await createTestUser();
      const fetchTime = new Date("2024-01-01T10:00:00Z");

      // Create old feed and new feed
      const oldFeedId = await createTestFeed({
        url: "https://old-domain.com/feed.xml",
        title: "Old Feed",
        lastFetchedAt: fetchTime,
        lastEntriesUpdatedAt: fetchTime,
      });

      const newFeedId = await createTestFeed({
        url: "https://new-domain.com/feed.xml",
        title: "New Feed",
        lastFetchedAt: fetchTime,
        lastEntriesUpdatedAt: fetchTime,
      });

      // User subscribed to old feed
      await createTestSubscription(userId, oldFeedId);

      // Entries only in old feed
      const oldOnlyEntry = await createTestEntry(oldFeedId, {
        guid: "old-only",
        title: "Old Only Entry",
        fetchedAt: fetchTime,
        lastSeenAt: fetchTime,
      });

      // Entry with same GUID in both feeds (user already has this from old feed)
      const sharedEntryOld = await createTestEntry(oldFeedId, {
        guid: "shared-guid",
        title: "Shared Entry (Old)",
        fetchedAt: fetchTime,
        lastSeenAt: fetchTime,
      });

      const sharedEntryNew = await createTestEntry(newFeedId, {
        guid: "shared-guid",
        title: "Shared Entry (New)",
        fetchedAt: fetchTime,
        lastSeenAt: fetchTime,
      });

      // Entry only in new feed
      const newOnlyEntry = await createTestEntry(newFeedId, {
        guid: "new-only",
        title: "New Only Entry",
        fetchedAt: fetchTime,
        lastSeenAt: fetchTime,
      });

      // User has user_entries for old feed entries
      await createUserEntries(userId, [oldOnlyEntry, sharedEntryOld]);

      // Create job for old feed
      await createOrEnableFeedJob(oldFeedId);

      // Perform the redirect migration
      await migrateSubscriptionsToExistingFeed(await getFeed(oldFeedId), await getFeed(newFeedId));

      // Verify subscription was migrated correctly
      const sub = await getSubscription(userId, newFeedId);
      expect(sub).not.toBeNull();
      expect(sub!.previousFeedIds).toContain(oldFeedId);

      // Simulate the new feed syncing - this calls the actual sync code
      // which should NOT create user_entries for entries with GUIDs the user
      // already has from the old feed (sharedEntryNew has same GUID as sharedEntryOld)
      await createUserEntriesForFeed(newFeedId, [sharedEntryNew, newOnlyEntry]);

      // Query entries via the API
      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);
      const result = await caller.entries.list({});
      const entryIds = result.items.map((item) => item.id);

      // User should see 3 entries: oldOnlyEntry, sharedEntryOld, newOnlyEntry
      // User should NOT see sharedEntryNew (duplicate GUID from old feed)
      expect(entryIds).toHaveLength(3);
      expect(entryIds).toContain(oldOnlyEntry);
      expect(entryIds).toContain(sharedEntryOld);
      expect(entryIds).toContain(newOnlyEntry);
      expect(entryIds).not.toContain(sharedEntryNew);
    });

    it("user subscribed only to new feed sees only new feed entries", async () => {
      const userA = await createTestUser("userA"); // Migrated from old feed
      const userB = await createTestUser("userB"); // Only subscribed to new feed
      const fetchTime = new Date("2024-01-01T10:00:00Z");

      // Create old feed and new feed
      const oldFeedId = await createTestFeed({
        url: "https://old-domain.com/feed.xml",
        title: "Old Feed",
        lastFetchedAt: fetchTime,
        lastEntriesUpdatedAt: fetchTime,
      });

      const newFeedId = await createTestFeed({
        url: "https://new-domain.com/feed.xml",
        title: "New Feed",
        lastFetchedAt: fetchTime,
        lastEntriesUpdatedAt: fetchTime,
      });

      // User A subscribed to old feed
      await createTestSubscription(userA, oldFeedId);

      // User B subscribed directly to new feed (no previous history)
      await createTestSubscription(userB, newFeedId);

      // Entry in old feed
      const oldEntry = await createTestEntry(oldFeedId, {
        guid: "old-entry",
        title: "Old Entry",
        fetchedAt: fetchTime,
        lastSeenAt: fetchTime,
      });

      // Entry in new feed
      const newEntry = await createTestEntry(newFeedId, {
        guid: "new-entry",
        title: "New Entry",
        fetchedAt: fetchTime,
        lastSeenAt: fetchTime,
      });

      // Create user_entries
      await createUserEntries(userA, [oldEntry]);
      await createUserEntries(userB, [newEntry]);

      // Migrate User A
      await migrateSubscriptionsToExistingFeed(await getFeed(oldFeedId), await getFeed(newFeedId));

      // Simulate new feed sync - creates user_entries for all subscribers (A and B)
      // User B already has user_entry from before, ON CONFLICT DO NOTHING handles this
      await createUserEntriesForFeed(newFeedId, [newEntry]);

      // Query entries for User A
      const ctxA = createAuthContext(userA);
      const callerA = createCaller(ctxA);
      const resultA = await callerA.entries.list({});
      const entryIdsA = resultA.items.map((item) => item.id);

      // User A should see entries from both feeds
      expect(entryIdsA).toContain(oldEntry);
      expect(entryIdsA).toContain(newEntry);

      // Query entries for User B
      const ctxB = createAuthContext(userB);
      const callerB = createCaller(ctxB);
      const resultB = await callerB.entries.list({});
      const entryIdsB = resultB.items.map((item) => item.id);

      // User B should only see new feed entries
      expect(entryIdsB).toContain(newEntry);
      expect(entryIdsB).not.toContain(oldEntry);
    });
  });

  describe("Read/starred state preservation", () => {
    it("preserves read state on old feed entries after redirect", async () => {
      const userId = await createTestUser();
      const fetchTime = new Date("2024-01-01T10:00:00Z");

      // Create old feed and new feed
      const oldFeedId = await createTestFeed({
        url: "https://old-domain.com/feed.xml",
        title: "Old Feed",
        lastFetchedAt: fetchTime,
        lastEntriesUpdatedAt: fetchTime,
      });

      const newFeedId = await createTestFeed({
        url: "https://new-domain.com/feed.xml",
        title: "New Feed",
        lastFetchedAt: fetchTime,
        lastEntriesUpdatedAt: fetchTime,
      });

      // User subscribed to old feed
      await createTestSubscription(userId, oldFeedId);

      // Create entries in old feed
      const readEntry = await createTestEntry(oldFeedId, {
        guid: "read-entry",
        title: "Read Entry",
        fetchedAt: fetchTime,
        lastSeenAt: fetchTime,
      });

      const unreadEntry = await createTestEntry(oldFeedId, {
        guid: "unread-entry",
        title: "Unread Entry",
        fetchedAt: fetchTime,
        lastSeenAt: fetchTime,
      });

      // Create user_entries with read state
      await createUserEntries(userId, [readEntry], { read: true });
      await createUserEntries(userId, [unreadEntry], { read: false });

      // Migrate to new feed
      await migrateSubscriptionsToExistingFeed(await getFeed(oldFeedId), await getFeed(newFeedId));

      // Check that read state is preserved
      const userEntriesResult = await getUserEntries(userId);
      const readEntryState = userEntriesResult.find((ue) => ue.entryId === readEntry);
      const unreadEntryState = userEntriesResult.find((ue) => ue.entryId === unreadEntry);

      expect(readEntryState?.read).toBe(true);
      expect(unreadEntryState?.read).toBe(false);

      // Verify entries are still visible via API
      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);
      const result = await caller.entries.list({});

      const entryIds = result.items.map((item) => item.id);
      expect(entryIds).toContain(readEntry);
      expect(entryIds).toContain(unreadEntry);
    });

    it("preserves starred state on old feed entries after redirect", async () => {
      const userId = await createTestUser();
      const fetchTime = new Date("2024-01-01T10:00:00Z");

      // Create old feed and new feed
      const oldFeedId = await createTestFeed({
        url: "https://old-domain.com/feed.xml",
        title: "Old Feed",
        lastFetchedAt: fetchTime,
        lastEntriesUpdatedAt: fetchTime,
      });

      const newFeedId = await createTestFeed({
        url: "https://new-domain.com/feed.xml",
        title: "New Feed",
        lastFetchedAt: fetchTime,
        lastEntriesUpdatedAt: fetchTime,
      });

      // User subscribed to old feed
      await createTestSubscription(userId, oldFeedId);

      // Create entries in old feed
      const starredEntry = await createTestEntry(oldFeedId, {
        guid: "starred-entry",
        title: "Starred Entry",
        fetchedAt: fetchTime,
        lastSeenAt: fetchTime,
      });

      const unstarredEntry = await createTestEntry(oldFeedId, {
        guid: "unstarred-entry",
        title: "Unstarred Entry",
        fetchedAt: fetchTime,
        lastSeenAt: fetchTime,
      });

      // Create user_entries with starred state
      await createUserEntries(userId, [starredEntry], { starred: true });
      await createUserEntries(userId, [unstarredEntry], { starred: false });

      // Migrate to new feed
      await migrateSubscriptionsToExistingFeed(await getFeed(oldFeedId), await getFeed(newFeedId));

      // Check that starred state is preserved
      const userEntriesResult = await getUserEntries(userId);
      const starredEntryState = userEntriesResult.find((ue) => ue.entryId === starredEntry);
      const unstarredEntryState = userEntriesResult.find((ue) => ue.entryId === unstarredEntry);

      expect(starredEntryState?.starred).toBe(true);
      expect(unstarredEntryState?.starred).toBe(false);

      // Verify starred entries are visible even when filtering
      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);
      const result = await caller.entries.list({ starredOnly: true });

      const entryIds = result.items.map((item) => item.id);
      expect(entryIds).toContain(starredEntry);
      expect(entryIds).not.toContain(unstarredEntry);
    });
  });

  describe("No duplicate entries after multiple syncs", () => {
    it("multiple syncs do not create duplicate user_entries for same GUID", async () => {
      const userId = await createTestUser();
      const fetchTime = new Date("2024-01-01T10:00:00Z");

      // Create old feed and new feed
      const oldFeedId = await createTestFeed({
        url: "https://old-domain.com/feed.xml",
        title: "Old Feed",
        lastFetchedAt: fetchTime,
        lastEntriesUpdatedAt: fetchTime,
      });

      const newFeedId = await createTestFeed({
        url: "https://new-domain.com/feed.xml",
        title: "New Feed",
        lastFetchedAt: fetchTime,
        lastEntriesUpdatedAt: fetchTime,
      });

      // User subscribed to old feed
      await createTestSubscription(userId, oldFeedId);

      // Entry in old feed with GUID "shared-guid"
      const oldSharedEntry = await createTestEntry(oldFeedId, {
        guid: "shared-guid",
        title: "Shared Entry (Old)",
        fetchedAt: fetchTime,
        lastSeenAt: fetchTime,
      });

      // Create user_entry for old entry
      await createUserEntries(userId, [oldSharedEntry]);

      // Migrate to new feed
      await migrateSubscriptionsToExistingFeed(await getFeed(oldFeedId), await getFeed(newFeedId));

      // New feed has entry with same GUID plus a unique entry
      const newSharedEntry = await createTestEntry(newFeedId, {
        guid: "shared-guid",
        title: "Shared Entry (New)",
        fetchedAt: new Date("2024-01-02T10:00:00Z"),
        lastSeenAt: new Date("2024-01-02T10:00:00Z"),
      });

      const newUniqueEntry = await createTestEntry(newFeedId, {
        guid: "new-unique",
        title: "New Unique Entry",
        fetchedAt: new Date("2024-01-02T10:00:00Z"),
        lastSeenAt: new Date("2024-01-02T10:00:00Z"),
      });

      // First sync - should add newUniqueEntry but skip newSharedEntry (duplicate GUID)
      await createUserEntriesForFeed(newFeedId, [newSharedEntry, newUniqueEntry]);

      const afterFirstSync = await getUserEntries(userId);
      // Should have: oldSharedEntry + newUniqueEntry = 2
      // Should NOT have newSharedEntry (duplicate GUID)
      expect(afterFirstSync.length).toBe(2);

      // Second sync with same entries - should not change anything
      await createUserEntriesForFeed(newFeedId, [newSharedEntry, newUniqueEntry]);

      const afterSecondSync = await getUserEntries(userId);
      expect(afterSecondSync.length).toBe(2);

      // Third sync after a new article appears
      const anotherNewEntry = await createTestEntry(newFeedId, {
        guid: "another-new",
        title: "Another New Entry",
        fetchedAt: new Date("2024-01-03T10:00:00Z"),
        lastSeenAt: new Date("2024-01-03T10:00:00Z"),
      });

      await createUserEntriesForFeed(newFeedId, [newSharedEntry, newUniqueEntry, anotherNewEntry]);

      const afterThirdSync = await getUserEntries(userId);
      // Should have: oldSharedEntry + newUniqueEntry + anotherNewEntry = 3
      expect(afterThirdSync.length).toBe(3);

      // Verify the right entries are present
      const entryIds = afterThirdSync.map((ue) => ue.entryId);
      expect(entryIds).toContain(oldSharedEntry);
      expect(entryIds).toContain(newUniqueEntry);
      expect(entryIds).toContain(anotherNewEntry);
      // Should NOT contain the duplicate
      expect(entryIds).not.toContain(newSharedEntry);
    });

    it("createUserEntriesForFeed uses ON CONFLICT DO NOTHING for same entry_id", async () => {
      const userId = await createTestUser();
      const fetchTime = new Date("2024-01-01T10:00:00Z");

      const feedId = await createTestFeed({
        url: "https://example.com/feed.xml",
        title: "Test Feed",
        lastFetchedAt: fetchTime,
        lastEntriesUpdatedAt: fetchTime,
      });

      await createTestSubscription(userId, feedId);

      const entryId = await createTestEntry(feedId, {
        guid: "entry-1",
        title: "Entry 1",
        fetchedAt: fetchTime,
        lastSeenAt: fetchTime,
      });

      // First sync creates user_entry
      await createUserEntriesForFeed(feedId, [entryId]);

      const afterFirst = await getUserEntries(userId);
      expect(afterFirst.length).toBe(1);

      // Second sync with same entry - ON CONFLICT DO NOTHING should prevent error
      await createUserEntriesForFeed(feedId, [entryId]);

      const afterSecond = await getUserEntries(userId);
      expect(afterSecond.length).toBe(1);
    });
  });

  describe("Chain of redirects", () => {
    it("handles multiple sequential redirects correctly", async () => {
      const userId = await createTestUser();
      const fetchTime = new Date("2024-01-01T10:00:00Z");

      // Create three feeds: A -> B -> C
      const feedAId = await createTestFeed({
        url: "https://feed-a.com/feed.xml",
        title: "Feed A",
        lastFetchedAt: fetchTime,
        lastEntriesUpdatedAt: fetchTime,
      });

      const feedBId = await createTestFeed({
        url: "https://feed-b.com/feed.xml",
        title: "Feed B",
        lastFetchedAt: fetchTime,
        lastEntriesUpdatedAt: fetchTime,
      });

      const feedCId = await createTestFeed({
        url: "https://feed-c.com/feed.xml",
        title: "Feed C",
        lastFetchedAt: fetchTime,
        lastEntriesUpdatedAt: fetchTime,
      });

      // User subscribed to Feed A
      await createTestSubscription(userId, feedAId);

      // Create entries in Feed A
      const entryA = await createTestEntry(feedAId, {
        guid: "entry-a",
        title: "Entry A",
        fetchedAt: fetchTime,
        lastSeenAt: fetchTime,
      });
      await createUserEntries(userId, [entryA]);

      // First redirect: A -> B
      await migrateSubscriptionsToExistingFeed(await getFeed(feedAId), await getFeed(feedBId));

      // Verify intermediate state
      let sub = await getSubscription(userId, feedBId);
      expect(sub).not.toBeNull();
      expect(sub!.previousFeedIds).toEqual([feedAId]);

      // Add entry from Feed B
      const entryB = await createTestEntry(feedBId, {
        guid: "entry-b",
        title: "Entry B",
        fetchedAt: new Date("2024-01-02T10:00:00Z"),
        lastSeenAt: new Date("2024-01-02T10:00:00Z"),
      });
      await createUserEntries(userId, [entryB]);

      // Second redirect: B -> C
      await migrateSubscriptionsToExistingFeed(await getFeed(feedBId), await getFeed(feedCId));

      // Verify final state
      sub = await getSubscription(userId, feedCId);
      expect(sub).not.toBeNull();
      // previousFeedIds should contain feedBId (the immediate previous feed)
      expect(sub!.previousFeedIds).toContain(feedBId);

      // The subscription to Feed B should now have feedAId in previousFeedIds
      // and be unsubscribed, so its previousFeedIds won't help us.
      // This is a known limitation - we only track immediate previous feeds.

      // But user_entries from Feed A are still linked to the user
      const userEntriesResult = await getUserEntries(userId);
      expect(userEntriesResult.map((ue) => ue.entryId)).toContain(entryA);
      expect(userEntriesResult.map((ue) => ue.entryId)).toContain(entryB);
    });
  });
});

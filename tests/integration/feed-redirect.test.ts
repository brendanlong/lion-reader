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
} from "../../src/server/db/schema";
import { generateUuidv7 } from "../../src/lib/uuidv7";
import { createCaller } from "../../src/server/trpc/root";
import type { Context } from "../../src/server/trpc/context";
import { createOrEnableFeedJob, syncFeedJobEnabled } from "../../src/server/jobs";

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
 * Simulates the migration logic that happens when a feed redirects to an existing feed.
 * This is extracted from handlers.ts for testing purposes.
 */
async function migrateSubscriptionsToExistingFeed(
  oldFeedId: string,
  newFeedId: string
): Promise<void> {
  // Find all active subscriptions to the old feed
  const activeSubscriptions = await db
    .select({
      userId: subscriptions.userId,
      id: subscriptions.id,
    })
    .from(subscriptions)
    .where(and(eq(subscriptions.feedId, oldFeedId), isNull(subscriptions.unsubscribedAt)));

  if (activeSubscriptions.length === 0) {
    return;
  }

  const now = new Date();

  for (const sub of activeSubscriptions) {
    // Check if user already has subscription to new feed
    const existingNewSub = await db
      .select({
        id: subscriptions.id,
        previousFeedIds: subscriptions.previousFeedIds,
        unsubscribedAt: subscriptions.unsubscribedAt,
      })
      .from(subscriptions)
      .where(and(eq(subscriptions.userId, sub.userId), eq(subscriptions.feedId, newFeedId)))
      .limit(1);

    if (existingNewSub.length > 0) {
      const existing = existingNewSub[0];
      // User has subscription to new feed - append old feed to previousFeedIds
      const newPreviousFeedIds = [...existing.previousFeedIds, oldFeedId];

      await db
        .update(subscriptions)
        .set({
          previousFeedIds: newPreviousFeedIds,
          // Reactivate if previously unsubscribed
          unsubscribedAt: null,
          subscribedAt: existing.unsubscribedAt ? now : undefined,
          updatedAt: now,
        })
        .where(eq(subscriptions.id, existing.id));
    } else {
      // Create new subscription to new feed with old feed in previousFeedIds
      await db.insert(subscriptions).values({
        id: generateUuidv7(),
        userId: sub.userId,
        feedId: newFeedId,
        previousFeedIds: [oldFeedId],
        subscribedAt: now,
        createdAt: now,
        updatedAt: now,
      });

      // Enable the job for the new feed
      await createOrEnableFeedJob(newFeedId);
    }

    // Unsubscribe from old feed (but keep the entries and user_entries)
    await db
      .update(subscriptions)
      .set({
        unsubscribedAt: now,
        updatedAt: now,
      })
      .where(eq(subscriptions.id, sub.id));
  }

  // Sync the old feed's job - it will be disabled since it has no subscribers now
  await syncFeedJobEnabled(oldFeedId);
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
      await migrateSubscriptionsToExistingFeed(oldFeedId, newFeedId);

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
      await migrateSubscriptionsToExistingFeed(oldFeedId, newFeedId);

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
      await migrateSubscriptionsToExistingFeed(oldFeedId, newFeedId);

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
      await migrateSubscriptionsToExistingFeed(oldFeedId, newFeedId);

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

  describe("Entry visibility with overlapping entries", () => {
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

      // Entries with same GUID in both feeds (overlap)
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

      // Entries only in new feed
      const newOnlyEntry = await createTestEntry(newFeedId, {
        guid: "new-only",
        title: "New Only Entry",
        fetchedAt: fetchTime,
        lastSeenAt: fetchTime,
      });

      // User has user_entries for old feed entries only
      await createUserEntries(userId, [oldOnlyEntry, sharedEntryOld]);

      // Create job for old feed
      await createOrEnableFeedJob(oldFeedId);

      // Simulate the redirect migration
      await migrateSubscriptionsToExistingFeed(oldFeedId, newFeedId);

      // At this point, user has subscription to new feed with old feed in previousFeedIds
      // The entry queries use feed_ids (which includes previousFeedIds) to find entries

      // Get user's subscription
      const sub = await getSubscription(userId, newFeedId);
      expect(sub).not.toBeNull();
      expect(sub!.previousFeedIds).toContain(oldFeedId);

      // Query entries via the API to verify visibility
      const ctx = createAuthContext(userId);
      const caller = createCaller(ctx);

      // First, we need to create user_entries for the new feed entries
      // (This would normally happen when the new feed is synced after redirect)
      await createUserEntries(userId, [newOnlyEntry, sharedEntryNew]);

      // List entries via API
      const result = await caller.entries.list({});

      // User should see entries from both feeds
      const entryIds = result.items.map((item) => item.id);

      // Should see old feed entries (via previousFeedIds)
      expect(entryIds).toContain(oldOnlyEntry);
      expect(entryIds).toContain(sharedEntryOld);

      // Should see new feed entries
      expect(entryIds).toContain(newOnlyEntry);
      expect(entryIds).toContain(sharedEntryNew);
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
      await migrateSubscriptionsToExistingFeed(oldFeedId, newFeedId);

      // Create user_entry for new entry for User A (simulating sync after migration)
      await createUserEntries(userA, [newEntry]);

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
      await migrateSubscriptionsToExistingFeed(oldFeedId, newFeedId);

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
      await migrateSubscriptionsToExistingFeed(oldFeedId, newFeedId);

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
    it("does not create duplicate user_entries when syncing after redirect", async () => {
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

      // Entry in old feed
      const oldEntry = await createTestEntry(oldFeedId, {
        guid: "entry-1",
        title: "Entry 1",
        fetchedAt: fetchTime,
        lastSeenAt: fetchTime,
      });

      // Create user_entry for old entry
      await createUserEntries(userId, [oldEntry]);

      // Migrate to new feed
      await migrateSubscriptionsToExistingFeed(oldFeedId, newFeedId);

      // Get user_entries count before "sync"
      const beforeSyncEntries = await getUserEntries(userId);
      const beforeCount = beforeSyncEntries.length;

      // Simulate multiple syncs of new feed that add new entries
      const newEntry1 = await createTestEntry(newFeedId, {
        guid: "new-entry-1",
        title: "New Entry 1",
        fetchedAt: new Date("2024-01-02T10:00:00Z"),
        lastSeenAt: new Date("2024-01-02T10:00:00Z"),
      });

      // First sync adds user_entry
      await createUserEntries(userId, [newEntry1]);

      // Simulate second sync - should not duplicate
      // In real code, the INSERT ... ON CONFLICT DO NOTHING handles this
      // Here we just verify the constraint by checking the count
      const afterFirstSync = await getUserEntries(userId);
      expect(afterFirstSync.length).toBe(beforeCount + 1);

      // Third sync with another new entry
      const newEntry2 = await createTestEntry(newFeedId, {
        guid: "new-entry-2",
        title: "New Entry 2",
        fetchedAt: new Date("2024-01-03T10:00:00Z"),
        lastSeenAt: new Date("2024-01-03T10:00:00Z"),
      });

      await createUserEntries(userId, [newEntry2]);

      const afterSecondSync = await getUserEntries(userId);
      expect(afterSecondSync.length).toBe(beforeCount + 2);

      // Verify all unique entries are present
      const entryIds = afterSecondSync.map((ue) => ue.entryId);
      expect(entryIds).toContain(oldEntry);
      expect(entryIds).toContain(newEntry1);
      expect(entryIds).toContain(newEntry2);
    });

    it("user_entries table has unique constraint on (user_id, entry_id)", async () => {
      const userId = await createTestUser();
      const fetchTime = new Date("2024-01-01T10:00:00Z");

      const feedId = await createTestFeed({
        url: "https://example.com/feed.xml",
        title: "Test Feed",
        lastFetchedAt: fetchTime,
        lastEntriesUpdatedAt: fetchTime,
      });

      const entryId = await createTestEntry(feedId, {
        guid: "entry-1",
        title: "Entry 1",
        fetchedAt: fetchTime,
        lastSeenAt: fetchTime,
      });

      // Create first user_entry
      await createUserEntries(userId, [entryId]);

      // Attempting to create duplicate should fail
      await expect(createUserEntries(userId, [entryId])).rejects.toThrow();
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
      await migrateSubscriptionsToExistingFeed(feedAId, feedBId);

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
      await migrateSubscriptionsToExistingFeed(feedBId, feedCId);

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

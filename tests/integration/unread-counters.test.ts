/**
 * Integration tests for the denormalized unread counters (issue #1117,
 * migration 0092): subscriptions.unread_count / starred_unread_count and
 * users.saved_unread_count / starred_unread_count, maintained by the
 * user_entries_counters_* statement triggers. Spam is permanently excluded.
 *
 * Nothing reads the counters yet (that's step 5b) — these tests verify the
 * WRITE side: after exercising every mutation path, the counters must equal
 * ground truth, which is asserted two ways:
 *   1. explicit expected values, and
 *   2. reconcileCounters() reporting ZERO fixes — the same self-healing sweep
 *      that runs in production, so "no drift after every path" is exactly the
 *      invariant the daily job checks.
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { eq, and } from "drizzle-orm";
import { db } from "../../src/server/db";
import { users, feeds, entries, subscriptions, userEntries } from "../../src/server/db/schema";
import { generateUuidv7 } from "../../src/lib/uuidv7";
import { createUserEntriesForFeed } from "../../src/server/feed/entry-processor";
import { migrateSubscriptionsToExistingFeed } from "../../src/server/jobs/handlers";
import { createSubscription } from "../../src/server/services/subscriptions";
import {
  countEntries,
  markEntriesRead,
  markAllEntriesRead,
  updateEntryStarred,
} from "../../src/server/services/entries";
import { createUploadedArticle, deleteSavedArticle } from "../../src/server/services/saved";
import { reconcileCounters } from "../../src/server/services/reconcile-counters";
import { getBulkEntryRelatedCounts } from "../../src/server/services/counts";

// ============================================================================
// Helpers
// ============================================================================

async function createTestUser(prefix = "counters-user"): Promise<string> {
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
    lastSeenAt: type === "web" ? (options.lastSeenAt ?? now) : null,
    createdAt: now,
    updatedAt: now,
  });
  return entryId;
}

async function subscriptionCounters(subscriptionId: string) {
  const [row] = await db
    .select({
      unread: subscriptions.unreadCount,
      starredUnread: subscriptions.starredUnreadCount,
    })
    .from(subscriptions)
    .where(eq(subscriptions.id, subscriptionId));
  return row;
}

async function userCounters(userId: string) {
  const [row] = await db
    .select({
      savedUnread: users.savedUnreadCount,
      starredUnread: users.starredUnreadCount,
    })
    .from(users)
    .where(eq(users.id, userId));
  return row;
}

/** Triggers must have kept everything exact: the sweep finds nothing to fix. */
async function expectNoDrift() {
  const result = await reconcileCounters(db);
  expect(result).toEqual({ subscriptionsFixed: 0, usersFixed: 0 });
}

async function cleanupTables() {
  await db.delete(userEntries);
  await db.delete(entries);
  await db.delete(subscriptions);
  await db.delete(feeds);
  await db.delete(users);
}

// ============================================================================
// Tests
// ============================================================================

describe("unread counters (triggers + reconciliation)", () => {
  beforeEach(cleanupTables);
  afterAll(cleanupTables);

  it("counts subscribe-time populated entries", async () => {
    const userId = await createTestUser();
    const now = new Date();
    const url = `https://example.com/populate-${generateUuidv7()}.xml`;
    const feedId = await createTestFeed({ url, lastEntriesUpdatedAt: now });
    await createTestEntry(feedId, { lastSeenAt: now });
    await createTestEntry(feedId, { lastSeenAt: now });

    const result = await createSubscription(db, userId, { url });

    expect(await subscriptionCounters(result.subscriptionId)).toEqual({
      unread: 2,
      starredUnread: 0,
    });
    await expectNoDrift();
  });

  it("counts fanout entries per subscriber and excludes spam", async () => {
    const userId = await createTestUser();
    // Email feed so a spam entry passes the entries_spam_only_email check.
    const feedId = await createTestFeed({ type: "email", userId });
    const subId = await createTestSubscription(userId, feedId);
    const hamId = await createTestEntry(feedId, { type: "email" });
    const spamId = await createTestEntry(feedId, { type: "email", isSpam: true });

    await createUserEntriesForFeed(feedId, [hamId, spamId]);

    // The spam row exists (visible when showSpam is on) but never counts.
    const [spamRow] = await db
      .select({ isSpam: userEntries.isSpam })
      .from(userEntries)
      .where(and(eq(userEntries.userId, userId), eq(userEntries.entryId, spamId)));
    expect(spamRow.isSpam).toBe(true);
    expect(await subscriptionCounters(subId)).toEqual({ unread: 1, starredUnread: 0 });
    await expectNoDrift();
  });

  it("tracks read / unread flips and ignores stale changedAt replays", async () => {
    const userId = await createTestUser();
    const feedId = await createTestFeed({});
    const subId = await createTestSubscription(userId, feedId);
    const entryId = await createTestEntry(feedId);
    await db.insert(userEntries).values({ userId, entryId });

    expect((await subscriptionCounters(subId)).unread).toBe(1);

    const t1 = new Date();
    await markEntriesRead(db, userId, [{ id: entryId, changedAt: t1 }], true);
    expect((await subscriptionCounters(subId)).unread).toBe(0);

    // Stale replay (older changedAt): the guarded UPDATE touches zero rows,
    // so the trigger sees an empty transition table and counters stay put.
    const stale = new Date(t1.getTime() - 60_000);
    await markEntriesRead(db, userId, [{ id: entryId, changedAt: stale }], false);
    expect((await subscriptionCounters(subId)).unread).toBe(0);

    // Genuine unread flips it back.
    await markEntriesRead(db, userId, [{ id: entryId, changedAt: new Date() }], false);
    expect((await subscriptionCounters(subId)).unread).toBe(1);
    await expectNoDrift();
  });

  it("tracks starring, and reading a starred entry decrements both counters", async () => {
    const userId = await createTestUser();
    const feedId = await createTestFeed({});
    const subId = await createTestSubscription(userId, feedId);
    const entryId = await createTestEntry(feedId);
    // starredChangedAt in the past — see the note in the merge test below.
    await db
      .insert(userEntries)
      .values({ userId, entryId, starredChangedAt: new Date(Date.now() - 60_000) });

    await updateEntryStarred(db, userId, entryId, true);
    expect(await subscriptionCounters(subId)).toEqual({ unread: 1, starredUnread: 1 });
    expect((await userCounters(userId)).starredUnread).toBe(1);

    await markEntriesRead(db, userId, [{ id: entryId }], true);
    expect(await subscriptionCounters(subId)).toEqual({ unread: 0, starredUnread: 0 });
    expect((await userCounters(userId)).starredUnread).toBe(0);

    await updateEntryStarred(db, userId, entryId, false);
    await expectNoDrift();
  });

  it("mark-all-read zeroes the subscription counter in one statement", async () => {
    const userId = await createTestUser();
    const feedId = await createTestFeed({});
    const subId = await createTestSubscription(userId, feedId);
    for (let i = 0; i < 5; i++) {
      const entryId = await createTestEntry(feedId);
      await db.insert(userEntries).values({ userId, entryId });
    }
    expect((await subscriptionCounters(subId)).unread).toBe(5);

    await markAllEntriesRead(db, { userId, subscriptionId: subId, showSpam: false });

    expect((await subscriptionCounters(subId)).unread).toBe(0);
    await expectNoDrift();
  });

  it("moves counts to the survivor on a feed merge (re-stamp UPDATE)", async () => {
    const userId = await createTestUser();
    const oldFeedId = await createTestFeed({ url: "https://old.example.com/feed.xml" });
    const newFeedId = await createTestFeed({ url: "https://new.example.com/feed.xml" });
    const oldSubId = await createTestSubscription(userId, oldFeedId);
    const existingNewSubId = await createTestSubscription(userId, newFeedId);
    const entryId = await createTestEntry(oldFeedId);
    // starredChangedAt in the past: the insert default is now() at microsecond
    // precision, which can tie with the JS millisecond changedAt and make the
    // star a stale no-op under the idempotency guard.
    await db
      .insert(userEntries)
      .values({ userId, entryId, starredChangedAt: new Date(Date.now() - 60_000) });
    await updateEntryStarred(db, userId, entryId, true);

    expect(await subscriptionCounters(oldSubId)).toEqual({ unread: 1, starredUnread: 1 });

    const [oldFeed] = await db.select().from(feeds).where(eq(feeds.id, oldFeedId));
    const [newFeed] = await db.select().from(feeds).where(eq(feeds.id, newFeedId));
    await migrateSubscriptionsToExistingFeed(oldFeed, newFeed);

    // The re-stamp UPDATE moved the contribution between subscriptions.
    expect(await subscriptionCounters(oldSubId)).toEqual({ unread: 0, starredUnread: 0 });
    expect(await subscriptionCounters(existingNewSubId)).toEqual({ unread: 1, starredUnread: 1 });
    await expectNoDrift();
  });

  it("tracks saved articles through upload and hard-delete cascade", async () => {
    const userId = await createTestUser();

    const article = await createUploadedArticle(db, userId, {
      contentHtml: "<p>Some uploaded content for the saved counter test.</p>",
      title: "Saved Counter Test",
      siteName: "Uploaded Document",
    });

    expect((await userCounters(userId)).savedUnread).toBe(1);

    await deleteSavedArticle(db, userId, article.id);
    expect((await userCounters(userId)).savedUnread).toBe(0);
    await expectNoDrift();
  });

  it("keeps dead-subscription counters accurate (starred-orphan term of the all badge)", async () => {
    const userId = await createTestUser();
    const feedId = await createTestFeed({});
    const subId = await createTestSubscription(userId, feedId);
    const entryId = await createTestEntry(feedId);
    // starredChangedAt in the past: the insert default is now() at microsecond
    // precision, which can tie with the JS millisecond changedAt and make the
    // star a stale no-op under the idempotency guard.
    await db
      .insert(userEntries)
      .values({ userId, entryId, starredChangedAt: new Date(Date.now() - 60_000) });
    await updateEntryStarred(db, userId, entryId, true);

    // Unsubscribe: no user_entries write, counters frozen — and still correct,
    // because the rows keep their stamp.
    await db
      .update(subscriptions)
      .set({ unsubscribedAt: new Date() })
      .where(eq(subscriptions.id, subId));
    expect(await subscriptionCounters(subId)).toEqual({ unread: 1, starredUnread: 1 });

    // Reading the starred orphan flows through the dead sub's counters.
    await markEntriesRead(db, userId, [{ id: entryId }], true);
    expect(await subscriptionCounters(subId)).toEqual({ unread: 0, starredUnread: 0 });
    await expectNoDrift();
  });

  it("computes the full 'all' badge algebra from the counters (step 5b, read side)", async () => {
    // all = SUM(unread_count) over ACTIVE subs
    //     + users.saved_unread_count
    //     + SUM(starred_unread_count) over INACTIVE subs (starred orphans)
    const userId = await createTestUser();

    // Active subscription with 2 unread entries.
    const activeFeedId = await createTestFeed({});
    await createTestSubscription(userId, activeFeedId);
    for (let i = 0; i < 2; i++) {
      const entryId = await createTestEntry(activeFeedId);
      await db.insert(userEntries).values({ userId, entryId });
    }

    // Unsubscribed subscription with 1 starred unread orphan (still visible).
    const goneFeedId = await createTestFeed({});
    const goneSubId = await createTestSubscription(userId, goneFeedId);
    const orphanId = await createTestEntry(goneFeedId);
    // starredChangedAt in the past — see the note in the merge test above.
    await db
      .insert(userEntries)
      .values({ userId, entryId: orphanId, starredChangedAt: new Date(Date.now() - 60_000) });
    await updateEntryStarred(db, userId, orphanId, true);
    await db
      .update(subscriptions)
      .set({ unsubscribedAt: new Date() })
      .where(eq(subscriptions.id, goneSubId));

    // One unread saved article.
    await createUploadedArticle(db, userId, {
      contentHtml: "<p>Saved content for the all-badge algebra test.</p>",
      title: "All Badge Algebra",
      siteName: "Uploaded Document",
    });

    const counts = await getBulkEntryRelatedCounts(db, userId, []);

    // all = 2 (active) + 1 (saved) + 1 (starred orphan on the inactive sub)
    expect(counts.all).toEqual({ unread: 4 });
    // starred = users.starred_unread_count = the one starred unread orphan
    expect(counts.starred).toEqual({ unread: 1 });
    // saved = users.saved_unread_count
    expect(counts.saved).toEqual({ unread: 1 });
    await expectNoDrift();
  });

  it("countEntries never counts spam and serves the badge shapes from counters", async () => {
    const userId = await createTestUser();
    // Email feed with one ham + one spam entry (spam is only valid on email).
    const feedId = await createTestFeed({ type: "email", userId });
    const subId = await createTestSubscription(userId, feedId);
    const hamId = await createTestEntry(feedId, { type: "email" });
    const spamId = await createTestEntry(feedId, { type: "email", isSpam: true });
    await createUserEntriesForFeed(feedId, [hamId, spamId]);

    // The three sidebar badge shapes (counter fast-path) exclude spam, always —
    // there is no showSpam parameter anymore (issue #1117: unread counts never
    // include spam, matching the counters).
    expect(await countEntries(db, userId, {})).toEqual({ unread: 1 });
    expect(await countEntries(db, userId, { starredOnly: true })).toEqual({ unread: 0 });
    expect(await countEntries(db, userId, { type: "saved" })).toEqual({ unread: 0 });

    // Scoped filters take the visible_entries scan path — same spam exclusion,
    // and the same value as the subscription's counter.
    expect(await countEntries(db, userId, { subscriptionId: subId })).toEqual({ unread: 1 });
    expect((await subscriptionCounters(subId)).unread).toBe(1);
    await expectNoDrift();
  });

  it("reconcileCounters detects and repairs corruption", async () => {
    const userId = await createTestUser();
    const feedId = await createTestFeed({});
    const subId = await createTestSubscription(userId, feedId);
    const entryId = await createTestEntry(feedId);
    // starredChangedAt in the past: the insert default is now() at microsecond
    // precision, which can tie with the JS millisecond changedAt and make the
    // star a stale no-op under the idempotency guard.
    await db
      .insert(userEntries)
      .values({ userId, entryId, starredChangedAt: new Date(Date.now() - 60_000) });
    await updateEntryStarred(db, userId, entryId, true);

    // Corrupt all four counters directly.
    await db
      .update(subscriptions)
      .set({ unreadCount: 99, starredUnreadCount: 99 })
      .where(eq(subscriptions.id, subId));
    await db
      .update(users)
      .set({ savedUnreadCount: 99, starredUnreadCount: 99 })
      .where(eq(users.id, userId));

    const result = await reconcileCounters(db);
    expect(result.subscriptionsFixed).toBeGreaterThanOrEqual(1);
    expect(result.usersFixed).toBeGreaterThanOrEqual(1);

    expect(await subscriptionCounters(subId)).toEqual({ unread: 1, starredUnread: 1 });
    expect(await userCounters(userId)).toEqual({ savedUnread: 0, starredUnread: 1 });
    await expectNoDrift();
  });
});

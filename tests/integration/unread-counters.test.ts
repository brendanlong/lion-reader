/**
 * Integration tests for the denormalized unread counters (issue #1117; rules
 * from #1846): subscriptions.unread_count and users.saved_unread_count /
 * starred_unread_count, maintained by the counter triggers. Spam is
 * permanently excluded. After exercising each mutation path, the counters
 * must equal ground truth, which is asserted two ways:
 *   1. explicit expected values, and
 *   2. reconcileCounters() reporting ZERO fixes — the same self-healing sweep
 *      that runs in production, so "no drift after every path" is exactly the
 *      invariant the daily job checks.
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { eq, and, sql } from "drizzle-orm";
import { db } from "../../src/server/db";
import { users, feeds, entries, subscriptions, userEntries } from "../../src/server/db/schema";
import { generateUuidv7 } from "../../src/lib/uuidv7";
import { createUserEntriesForFeed } from "../../src/server/feed/entry-processor";
import { migrateSubscriptionsToExistingFeed } from "../../src/server/jobs/handlers/fetch-feed";
import { createSubscription } from "../../src/server/services/subscriptions";
import {
  countEntries,
  markEntriesRead,
  markAllEntriesRead,
  updateEntryStarred,
} from "../../src/server/services/entries";
import { uploadArticle, deleteSavedArticle } from "../../src/server/services/saved";
import { reconcileCounters } from "../../src/server/services/reconcile-counters";
import { getBulkEntryRelatedCounts } from "../../src/server/services/counts";
import { createTestEntry, createTestFeed, createTestSubscription, createTestUser } from "./helpers";

// ============================================================================
// Helpers
// ============================================================================

async function subscriptionCounters(subscriptionId: string) {
  const [row] = await db
    .select({ unread: subscriptions.unreadCount })
    .from(subscriptions)
    .where(eq(subscriptions.id, subscriptionId));
  return row;
}

async function userCounters(userId: string) {
  const [row] = await db
    .select({
      savedUnread: sql<number>`COALESCE((SELECT unread_count FROM subscriptions s
        WHERE s.user_id = users.id AND s.type = 'saved'), 0)`.mapWith(Number),
      starredUnread: users.starredUnreadCount,
    })
    .from(users)
    .where(eq(users.id, userId));
  return row;
}

/** Triggers must have kept everything exact: the sweep finds nothing to fix. */
async function expectNoDrift() {
  const result = await reconcileCounters(db);
  expect(result).toEqual({
    userEntriesFixed: 0,
    subscriptionsFixed: 0,
    usersFixed: 0,
    tagsFixed: 0,
  });
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

    expect(await subscriptionCounters(result.subscriptionId)).toEqual({ unread: 2 });
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
    expect(await subscriptionCounters(subId)).toEqual({ unread: 1 });
    await expectNoDrift();
  });

  it("tracks read / unread flips and ignores stale changedAt replays", async () => {
    const userId = await createTestUser();
    const feedId = await createTestFeed();
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

  it("tracks starring, and reading a starred entry decrements both badges", async () => {
    const userId = await createTestUser();
    const feedId = await createTestFeed();
    const subId = await createTestSubscription(userId, feedId);
    const entryId = await createTestEntry(feedId);
    // starredChangedAt in the past — see the note in the merge test below.
    await db
      .insert(userEntries)
      .values({ userId, entryId, starredChangedAt: new Date(Date.now() - 60_000) });

    await updateEntryStarred(db, userId, entryId, true);
    expect(await subscriptionCounters(subId)).toEqual({ unread: 1 });
    expect((await userCounters(userId)).starredUnread).toBe(1);

    await markEntriesRead(db, userId, [{ id: entryId }], true);
    expect(await subscriptionCounters(subId)).toEqual({ unread: 0 });
    expect((await userCounters(userId)).starredUnread).toBe(0);

    await updateEntryStarred(db, userId, entryId, false);
    await expectNoDrift();
  });

  it("mark-all-read zeroes the subscription counter in one statement", async () => {
    const userId = await createTestUser();
    const feedId = await createTestFeed();
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

  it("counts a merged article in the survivor and in the subscription it left", async () => {
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

    expect(await subscriptionCounters(oldSubId)).toEqual({ unread: 1 });

    const [oldFeed] = await db.select().from(feeds).where(eq(feeds.id, oldFeedId));
    const [newFeed] = await db.select().from(feeds).where(eq(feeds.id, newFeedId));
    await migrateSubscriptionsToExistingFeed(oldFeed, newFeed);

    // The article joins the survivor and stays in the (now inactive) old
    // subscription, which still counts it (#1846).
    expect(await subscriptionCounters(oldSubId)).toEqual({ unread: 1 });
    expect(await subscriptionCounters(existingNewSubId)).toEqual({ unread: 1 });
    await expectNoDrift();
  });

  it("tracks saved articles through upload and hard-delete cascade", async () => {
    const userId = await createTestUser();

    const article = await uploadArticle(db, userId, {
      content: "Some uploaded content for the saved counter test.",
      title: "Saved Counter Test",
    });

    expect((await userCounters(userId)).savedUnread).toBe(1);

    await deleteSavedArticle(db, userId, article.id);
    expect((await userCounters(userId)).savedUnread).toBe(0);
    await expectNoDrift();
  });

  it("keeps an unsubscribed subscription's counter accurate", async () => {
    const userId = await createTestUser();
    const feedId = await createTestFeed();
    const subId = await createTestSubscription(userId, feedId);
    const entryId = await createTestEntry(feedId);
    // starredChangedAt in the past: the insert default is now() at microsecond
    // precision, which can tie with the JS millisecond changedAt and make the
    // star a stale no-op under the idempotency guard.
    await db
      .insert(userEntries)
      .values({ userId, entryId, starredChangedAt: new Date(Date.now() - 60_000) });
    await updateEntryStarred(db, userId, entryId, true);

    // An unsubscribed subscription keeps counting its memberships.
    await db
      .update(subscriptions)
      .set({ unsubscribedAt: new Date() })
      .where(eq(subscriptions.id, subId));
    expect(await subscriptionCounters(subId)).toEqual({ unread: 1 });

    // Reading the starred article moves the inactive subscription's counter.
    await markEntriesRead(db, userId, [{ id: entryId }], true);
    expect(await subscriptionCounters(subId)).toEqual({ unread: 0 });
    await expectNoDrift();
  });

  it("counts every visible unread article in All", async () => {
    // All = unread articles that are starred or in an active subscription.
    const userId = await createTestUser();

    // Active subscription with 2 unread entries.
    const activeFeedId = await createTestFeed();
    await createTestSubscription(userId, activeFeedId);
    for (let i = 0; i < 2; i++) {
      const entryId = await createTestEntry(activeFeedId);
      await db.insert(userEntries).values({ userId, entryId });
    }

    // Unsubscribed subscription with 1 starred unread orphan (still visible).
    const goneFeedId = await createTestFeed();
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
    await uploadArticle(db, userId, {
      content: "Saved content for the all-badge algebra test.",
      title: "All Badge Algebra",
    });

    const counts = await getBulkEntryRelatedCounts(db, userId, []);

    // all = 2 (active) + 1 (saved) + 1 (starred, on the inactive sub)
    expect(counts.all).toEqual({ unread: 4 });
    // starred = users.starred_unread_count = the one starred unread orphan
    expect(counts.starred).toEqual({ unread: 1 });
    // saved = the saved subscription's count
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
    const feedId = await createTestFeed();
    const subId = await createTestSubscription(userId, feedId);
    const entryId = await createTestEntry(feedId);
    // starredChangedAt in the past: the insert default is now() at microsecond
    // precision, which can tie with the JS millisecond changedAt and make the
    // star a stale no-op under the idempotency guard.
    await db
      .insert(userEntries)
      .values({ userId, entryId, starredChangedAt: new Date(Date.now() - 60_000) });
    await updateEntryStarred(db, userId, entryId, true);

    // Corrupt the counters, and the article's active_memberships, directly.
    await db.update(subscriptions).set({ unreadCount: 99 }).where(eq(subscriptions.id, subId));
    await db.update(users).set({ starredUnreadCount: 99 }).where(eq(users.id, userId));
    await db
      .update(userEntries)
      .set({ activeMemberships: 5 })
      .where(and(eq(userEntries.userId, userId), eq(userEntries.entryId, entryId)));

    const result = await reconcileCounters(db);
    expect(result.userEntriesFixed).toBe(1);
    expect(result.subscriptionsFixed).toBeGreaterThanOrEqual(1);
    expect(result.usersFixed).toBeGreaterThanOrEqual(1);

    expect(await subscriptionCounters(subId)).toEqual({ unread: 1 });
    expect(await userCounters(userId)).toEqual({ savedUnread: 0, starredUnread: 1 });
    await expectNoDrift();
  });
});

describe("recompute_list_counters", () => {
  it("always plans per call (#1862)", async () => {
    const result = await db.execute<{ proconfig: string[] | null }>(sql`
      SELECT proconfig FROM pg_proc WHERE proname = 'recompute_list_counters'
    `);
    expect(
      result.rows[0]?.proconfig ?? [],
      "its generic plan is ~15x slower for heavy users, and CREATE OR REPLACE FUNCTION drops " +
        "the setting: repeat `SET plan_cache_mode = force_custom_plan` when redefining it (#1862)"
    ).toContain("plan_cache_mode=force_custom_plan");
  });
});

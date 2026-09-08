/**
 * Every surface that reports a subscription's unread badge must agree with
 * `subscriptions.list`.
 *
 * `subscriptions.list` reads `user_feeds.unread_count` — the trigger-maintained
 * counter, which permanently excludes spam (see "Unread Counts" in
 * `src/server/CLAUDE.md`). Three other surfaces used to hand-roll a `count(*)`
 * over `visible_entries` / `user_entries` with no `is_spam` predicate, so a
 * subscription with spam reported a larger number and the sidebar badge
 * contradicted the list it sits next to. These tests pin all of them to the
 * counter by construction: each asserts equality with `subscriptions.list`
 * rather than a hard-coded number, so a future scan-based reimplementation
 * fails here no matter what it counts.
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/server/db";
import {
  users,
  feeds,
  entries,
  subscriptions,
  subscriptionTags,
  userEntries,
  tags,
} from "../../src/server/db/schema";
import { createCaller } from "../../src/server/trpc/root";
import { createSubscription } from "../../src/server/services/subscriptions";
import {
  createAuthContext,
  createTestEntry,
  createTestFeed,
  createTestSubscription,
  createTestUser,
} from "./helpers";

// ============================================================================
// Helpers
// ============================================================================

interface SpamFixture {
  userId: string;
  feedId: string;
  feedUrl: string;
  subscriptionId: string;
}

/**
 * A subscription to an email feed holding one ordinary unread entry and one
 * unread *spam* entry, both visible to the user.
 *
 * Spam only exists on email entries (`entries_spam_only_email`), and email
 * entries must have a NULL `last_seen_at` (`entries_last_seen_only_fetched`),
 * so the feed is an email feed throughout. `createTestEntry`'s `userIds`
 * inserts the `user_entries` rows; the `user_entries_fill_denormalized` trigger
 * copies `is_spam` off the entry.
 */
async function seedSpammySubscription(): Promise<SpamFixture> {
  const userId = await createTestUser();
  const feedId = await createTestFeed({ type: "email", userId });
  const [feed] = await db.select().from(feeds).where(eq(feeds.id, feedId));
  const subscriptionId = await createTestSubscription(userId, feedId);

  await createTestEntry(feedId, { type: "email", title: "Real mail", userIds: [userId] });
  await createTestEntry(feedId, {
    type: "email",
    title: "Spam mail",
    isSpam: true,
    userIds: [userId],
  });

  return { userId, feedId, feedUrl: feed.url!, subscriptionId };
}

/** The unread count `subscriptions.list` shows — the reference every surface must match. */
async function listedUnreadCount(userId: string, subscriptionId: string): Promise<number> {
  const { items } = await createCaller(await createAuthContext(userId)).subscriptions.list({});
  const item = items.find((s) => s.id === subscriptionId);
  if (!item) {
    throw new Error(`subscriptions.list did not return ${subscriptionId}`);
  }
  return item.unreadCount;
}

// ============================================================================
// Tests
// ============================================================================

describe("unread counts exclude spam on every surface", () => {
  beforeEach(async () => {
    await db.delete(userEntries);
    await db.delete(subscriptionTags);
    await db.delete(entries);
    await db.delete(subscriptions);
    await db.delete(tags);
    await db.delete(feeds);
    await db.delete(users);
  });

  afterAll(async () => {
    await db.delete(userEntries);
    await db.delete(subscriptionTags);
    await db.delete(entries);
    await db.delete(subscriptions);
    await db.delete(tags);
    await db.delete(feeds);
    await db.delete(users);
  });

  it("subscriptions.list reports only the non-spam unread entry", async () => {
    const { userId, subscriptionId } = await seedSpammySubscription();

    // The baseline the other three assertions compare against: 1 of the 2
    // unread rows is spam, so the counter says 1.
    expect(await listedUnreadCount(userId, subscriptionId)).toBe(1);
  });

  it("sync.events subscription_created matches subscriptions.list", async () => {
    const { userId, subscriptionId } = await seedSpammySubscription();

    // The SSE-down polling fallback replays the subscription as "created"
    // because it was subscribed after the cursor.
    const result = await createCaller(await createAuthContext(userId)).sync.events({
      cursors: { subscriptions: new Date("2020-01-01T00:00:00Z").toISOString() },
    });

    const created = result.events.filter((e) => e.type === "subscription_created");
    expect(created).toHaveLength(1);
    const event = created[0];
    if (event.type !== "subscription_created") throw new Error("unreachable");

    expect(event.subscription.id).toBe(subscriptionId);
    expect(event.subscription.unreadCount).toBe(await listedUnreadCount(userId, subscriptionId));
  });

  it("subscriptions.update matches subscriptions.list", async () => {
    const { userId, subscriptionId } = await seedSpammySubscription();

    const updated = await createCaller(await createAuthContext(userId)).subscriptions.update({
      id: subscriptionId,
      customTitle: "Renamed",
    });

    expect(updated.unreadCount).toBe(await listedUnreadCount(userId, subscriptionId));
  });

  it("resubscribing matches subscriptions.list", async () => {
    const { userId, feedUrl, subscriptionId } = await seedSpammySubscription();

    // Soft-delete, then resubscribe: the reactivation path reuses the existing
    // user_entries rows (an email feed populates nothing at subscribe time,
    // since its entries have no last_seen_at), so this is the case where the
    // old count(*) saw the spam row.
    await db
      .update(subscriptions)
      .set({ unsubscribedAt: new Date() })
      .where(eq(subscriptions.id, subscriptionId));

    const result = await createSubscription(db, userId, { url: feedUrl });

    expect(result.subscriptionId).toBe(subscriptionId);
    expect(result.alreadyActive).toBe(false);
    expect(result.unreadCount).toBe(await listedUnreadCount(userId, subscriptionId));
    // The bulk counts published alongside the SSE event must agree too.
    expect(result.counts?.subscriptions).toEqual([{ id: subscriptionId, unread: 1 }]);
  });
});

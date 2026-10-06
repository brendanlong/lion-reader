/**
 * The database is about to give each user a saved subscription (type `saved`,
 * no feed) to hold the Saved list's memberships (#1846 phase 4). Until the apps
 * move to memberships it stays invisible and inert: no surface lists, counts or
 * syncs it, and it can't be tagged, renamed or unsubscribed. These tests insert
 * one the way the database will and check each surface ignores it.
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/server/db";
import {
  collectionEntries,
  entries,
  feeds,
  jobs,
  subscriptionTags,
  subscriptions,
  tags,
  userEntries,
  users,
} from "../../src/server/db/schema";
import { usageLimitsConfig } from "../../src/server/config/env";
import { createSubscription } from "../../src/server/services/subscriptions";
import { reconcileCounters } from "../../src/server/services/reconcile-counters";
import {
  getGreaderUnreadCounts,
  listGreaderSubscriptions,
  resolveFeedStreamFilter,
} from "../../src/server/google-reader/subscriptions";
import { feedStreamIdToSubscriptionUuid } from "../../src/server/google-reader/id";
import { registerTools } from "../../src/server/mcp/tools";
import { createCaller } from "../../src/server/trpc/root";
import {
  createAuthContext,
  createTestEntry,
  createTestFeed,
  createTestSavedSubscription,
  createTestSubscription,
  createTestTag,
  createTestUser,
} from "./helpers";

async function cleanup(): Promise<void> {
  await db.delete(collectionEntries);
  await db.delete(userEntries);
  await db.delete(entries);
  await db.delete(subscriptionTags);
  await db.delete(tags);
  await db.delete(subscriptions);
  await db.delete(jobs);
  await db.delete(feeds);
  await db.delete(users);
}

/**
 * A user with a web subscription holding one unread entry, one unread saved
 * article, and the saved subscription, created after an older listed one so
 * it holds the newest `updated_at`.
 */
async function setup() {
  const userId = await createTestUser();
  const feedId = await createTestFeed({ title: "Source" });
  const webId = await createTestSubscription(userId, feedId, {
    updatedAt: new Date("2026-01-01T00:00:00Z"),
  });
  await createTestEntry(feedId, { userIds: [userId] });
  const saved = await createTestSavedSubscription(userId);
  await createTestEntry(saved.savedFeedId, { type: "saved", userIds: [userId] });
  const [row] = await db
    .select({ greaderStreamId: subscriptions.greaderStreamId })
    .from(subscriptions)
    .where(eq(subscriptions.id, saved.subscriptionId));
  return { userId, webId, ...saved, savedStreamId: row.greaderStreamId };
}

function callTool(name: string, userId: string, args: unknown) {
  const tool = registerTools().find((t) => t.name === name);
  if (!tool) throw new Error(`Tool not registered: ${name}`);
  return tool.handler(db, userId, args);
}

describe("the saved subscription (#1846)", () => {
  beforeEach(cleanup);
  afterAll(cleanup);

  it("is left out of subscriptions.list, subscriptions.get and MCP", async () => {
    const { userId, webId, subscriptionId } = await setup();
    const caller = createCaller(await createAuthContext(userId));

    for (const input of [{}, { uncategorized: true }, { type: "saved" as const }]) {
      expect((await caller.subscriptions.list(input)).items.map((s) => s.id)).toEqual(
        input.type ? [] : [webId]
      );
    }
    await expect(caller.subscriptions.get({ id: subscriptionId })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    const listed = (await callTool("list_subscriptions", userId, {})) as {
      subscriptions: Array<{ id: string }>;
    };
    expect(listed.subscriptions.map((s) => s.id)).toEqual([webId]);
  });

  it("can't be tagged, renamed or unsubscribed", async () => {
    const { userId, subscriptionId } = await setup();
    const caller = createCaller(await createAuthContext(userId));
    const tagId = await createTestTag(userId);

    await expect(
      caller.subscriptions.setTags({ id: subscriptionId, tagIds: [tagId] })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      caller.subscriptions.update({ id: subscriptionId, customTitle: "Mine" })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(caller.subscriptions.delete({ id: subscriptionId })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });

    expect(
      await db
        .select({
          customTitle: subscriptions.customTitle,
          unsubscribedAt: subscriptions.unsubscribedAt,
        })
        .from(subscriptions)
        .where(eq(subscriptions.id, subscriptionId))
    ).toEqual([{ customTitle: "Saved", unsubscribedAt: null }]);
    expect(
      await db
        .select()
        .from(subscriptionTags)
        .where(eq(subscriptionTags.subscriptionId, subscriptionId))
    ).toEqual([]);
  });

  it("doesn't count as a feed in Uncategorized or toward the subscription cap", async () => {
    const { userId } = await setup();
    const caller = createCaller(await createAuthContext(userId));

    expect((await caller.tags.list()).uncategorized.feedCount).toBe(1);

    const cap = usageLimitsConfig.maxSubscriptionsPerUser;
    usageLimitsConfig.maxSubscriptionsPerUser = 2;
    try {
      const result = await createSubscription(
        db,
        userId,
        { url: "https://example.com/second.xml" },
        { skipInitialPopulate: true }
      );
      expect(result.alreadyActive).toBe(false);
    } finally {
      usageLimitsConfig.maxSubscriptionsPerUser = cap;
    }
  });

  it("leaves Google Reader's synthetic Saved stream in place", async () => {
    const { userId, webId, savedFeedId, savedStreamId } = await setup();

    expect((await listGreaderSubscriptions(db, userId)).map((s) => [s.id, s.type])).toEqual([
      [webId, "web"],
      [savedFeedId, "saved"],
    ]);
    const { subscriptions: counts } = await getGreaderUnreadCounts(db, userId);
    expect(counts.filter((c) => c.streamId === savedStreamId.toString())).toEqual([
      { streamId: savedStreamId.toString(), unreadCount: 1 },
    ]);
    expect(counts).toHaveLength(2);
    expect(await resolveFeedStreamFilter(db, userId, savedStreamId)).toEqual({ type: "saved" });
    expect(await feedStreamIdToSubscriptionUuid(db, userId, savedStreamId)).toBeNull();
  });

  it("isn't synced as a subscription change", async () => {
    const { userId, webId } = await setup();
    const caller = createCaller(await createAuthContext(userId));
    const [web] = await db
      .select({ updatedAt: subscriptions.updatedAt })
      .from(subscriptions)
      .where(eq(subscriptions.id, webId));

    const cursors = await caller.sync.cursors();
    expect(cursors.subscriptions && new Date(cursors.subscriptions)).toEqual(web.updatedAt);

    const { events } = await caller.sync.events({
      cursors: { subscriptions: new Date("2020-01-01T00:00:00Z").toISOString() },
    });
    expect(
      events.flatMap((e) =>
        e.type.startsWith("subscription_") && "subscriptionId" in e ? [e.subscriptionId] : []
      )
    ).toEqual([webId]);
  });

  it("leaves today's counters alone: saved articles still count once, as saved", async () => {
    const { userId, subscriptionId, savedFeedId } = await setup();
    // A saved article inserted while the saved subscription exists isn't
    // stamped with it: the saved subscription has no feed to match on.
    const laterId = await createTestEntry(savedFeedId, { type: "saved", userIds: [userId] });
    const caller = createCaller(await createAuthContext(userId));

    expect(
      await db
        .select({ subscriptionId: userEntries.subscriptionId })
        .from(userEntries)
        .where(eq(userEntries.entryId, laterId))
    ).toEqual([{ subscriptionId: null }]);
    expect(await caller.entries.count({ type: "saved" })).toEqual({ unread: 2 });
    expect(await caller.entries.count({})).toEqual({ unread: 3 });
    expect(
      await db
        .select({ unread: subscriptions.unreadCount, starred: subscriptions.starredUnreadCount })
        .from(subscriptions)
        .where(eq(subscriptions.id, subscriptionId))
    ).toEqual([{ unread: 0, starred: 0 }]);
    expect(await reconcileCounters(db)).toEqual({
      subscriptionsFixed: 0,
      usersFixed: 0,
      tagsFixed: 0,
    });
  });
});

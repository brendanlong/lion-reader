/**
 * Each user's saved subscription (type `saved`, no feed) holds the Saved
 * list's memberships (#1846). Subscription lists show it, but it can't be
 * tagged, renamed or unsubscribed, and it isn't in Uncategorized, the
 * subscription cap, OPML or sync's subscription deltas. These tests insert one
 * the way the database does and check each surface.
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/server/db";
import {
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
import {
  createSubscription,
  exportSubscriptionsOpml,
} from "../../src/server/services/subscriptions";
import { reconcileCounters } from "../../src/server/services/reconcile-counters";
import {
  getGreaderUnreadCounts,
  listGreaderSubscriptions,
  resolveFeedStreamFilter,
} from "../../src/server/google-reader/subscriptions";
import { feedStreamIdToSubscriptionUuid } from "../../src/server/google-reader/id";
import {
  buildUncategorizedSubscriptionIdsSubquery,
  verifySubscriptionOwnership,
} from "../../src/server/services/entry-filters";
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
  const subscriptionId = await createTestSavedSubscription(userId);
  await createTestEntry(userId, { type: "saved", userIds: [userId] });
  const [row] = await db
    .select({ greaderStreamId: subscriptions.greaderStreamId })
    .from(subscriptions)
    .where(eq(subscriptions.id, subscriptionId));
  return { userId, webId, subscriptionId, savedStreamId: row.greaderStreamId };
}

function callTool(name: string, userId: string, args: unknown) {
  const tool = registerTools().find((t) => t.name === name);
  if (!tool) throw new Error(`Tool not registered: ${name}`);
  return tool.handler(db, userId, args);
}

describe("the saved subscription (#1846)", () => {
  beforeEach(cleanup);
  afterAll(cleanup);

  it("is listed by subscriptions.list, subscriptions.get and MCP, but never as uncategorized", async () => {
    const { userId, webId, subscriptionId } = await setup();
    const caller = createCaller(await createAuthContext(userId));
    const saved = {
      id: subscriptionId,
      type: "saved",
      url: null,
      title: "Saved",
      unreadCount: 1,
      tags: [],
    };

    expect((await caller.subscriptions.list()).items).toMatchObject([saved, { id: webId }]);
    expect((await caller.subscriptions.list({ type: "saved" })).items).toMatchObject([saved]);
    expect(
      (await caller.subscriptions.list({ uncategorized: true })).items.map((s) => s.id)
    ).toEqual([webId]);
    expect(await caller.subscriptions.get({ id: subscriptionId })).toMatchObject(saved);
    const listed = (await callTool("list_subscriptions", userId, {})) as {
      subscriptions: Array<{ id: string }>;
    };
    expect(listed.subscriptions.map((s) => s.id)).toEqual([subscriptionId, webId]);
  });

  it("filters to Saved as a subscription, but isn't part of Uncategorized", async () => {
    const { userId, webId, subscriptionId } = await setup();
    const caller = createCaller(await createAuthContext(userId));

    expect(await verifySubscriptionOwnership(db, subscriptionId, userId)).toBe(true);
    const bySubscription = await caller.entries.list({ subscriptionId });
    const saved = await caller.entries.list({ type: "saved" });
    expect(bySubscription.items.map((e) => e.id)).toEqual(saved.items.map((e) => e.id));
    expect(saved.items).toHaveLength(1);
    expect(
      (await buildUncategorizedSubscriptionIdsSubquery(db, userId)).map((r) => r.subscriptionId)
    ).toEqual([webId]);
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

  it("doesn't count as a feed in Uncategorized or toward the subscription cap, nor export", async () => {
    const { userId } = await setup();
    const caller = createCaller(await createAuthContext(userId));

    expect((await caller.tags.list()).uncategorized.feedCount).toBe(1);
    expect((await exportSubscriptionsOpml(db, userId)).feedCount).toBe(1);

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

  it("is Google Reader's Saved stream, at the saved feed's stream id", async () => {
    const { userId, webId, subscriptionId, savedStreamId } = await setup();

    expect((await listGreaderSubscriptions(db, userId)).map((s) => [s.id, s.type])).toEqual([
      [webId, "web"],
      [subscriptionId, "saved"],
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

  it("counts saved articles once, in Saved and in the saved subscription", async () => {
    const { userId, subscriptionId } = await setup();
    await createTestEntry(userId, { type: "saved", userIds: [userId] });
    const caller = createCaller(await createAuthContext(userId));

    expect(await caller.entries.count({ type: "saved" })).toEqual({ unread: 2 });
    expect(await caller.entries.count({})).toEqual({ unread: 3 });
    expect(
      await db
        .select({ unread: subscriptions.unreadCount })
        .from(subscriptions)
        .where(eq(subscriptions.id, subscriptionId))
    ).toEqual([{ unread: 2 }]);
    expect(await reconcileCounters(db)).toEqual({
      userEntriesFixed: 0,
      subscriptionsFixed: 0,
      usersFixed: 0,
      tagsFixed: 0,
    });
  });
});

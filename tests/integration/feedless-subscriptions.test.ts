/**
 * A subscription may have no feed, and a collection never has one (#1846).
 * Every read takes a subscription's type and name from the subscription
 * itself, and clients still get the fields released apps require.
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/server/db";
import {
  collectionEntries,
  entries,
  feeds,
  subscriptionTags,
  subscriptions,
  tags,
  userEntries,
  users,
} from "../../src/server/db/schema";
import { addEntriesToCollection, createCollection } from "../../src/server/services/collections";
import { exportSubscriptionsOpml, unsubscribe } from "../../src/server/services/subscriptions";
import { deleteUser } from "../../src/server/services/users";
import { listGreaderSubscriptions } from "../../src/server/google-reader/subscriptions";
import { listWallabagTags } from "../../src/server/wallabag/tags";
import { publishNewEntry } from "../../src/server/redis/pubsub";
import { createCaller } from "../../src/server/trpc/root";
import {
  createAuthContext,
  createTestEntry,
  createTestFeed,
  createTestSubscription,
  createTestTag,
  createTestUser,
} from "./helpers";
import { openSseStream, publishUntil } from "../utils/sse";

async function cleanup(): Promise<void> {
  await db.delete(collectionEntries);
  await db.delete(userEntries);
  await db.delete(entries);
  await db.delete(subscriptionTags);
  await db.delete(tags);
  await db.delete(subscriptions);
  await db.delete(feeds);
  await db.delete(users);
}

async function newCollection(userId: string, name: string): Promise<string> {
  return (await createCollection(db, userId, name)).subscription.id;
}

/** A user with a web subscription, one unread entry in it, and a collection holding that entry. */
async function setup() {
  const userId = await createTestUser();
  const feedId = await createTestFeed({ title: "Source" });
  const sourceId = await createTestSubscription(userId, feedId);
  const entryId = await createTestEntry(feedId, { userIds: [userId] });
  const collectionId = await newCollection(userId, "Reading");
  await addEntriesToCollection(db, userId, collectionId, [entryId]);
  return { userId, feedId, sourceId, entryId, collectionId };
}

describe("subscriptions without a feed (#1846)", () => {
  beforeEach(cleanup);
  afterAll(cleanup);

  it("creating a collection creates no feed", async () => {
    const userId = await createTestUser();
    const caller = createCaller(await createAuthContext(userId));

    const { subscription } = await caller.collections.create({ name: "Reading" });

    expect(
      await db
        .select({ feedId: subscriptions.feedId })
        .from(subscriptions)
        .where(eq(subscriptions.id, subscription.id))
    ).toEqual([{ feedId: null }]);
    expect(await db.select({ id: feeds.id }).from(feeds).where(eq(feeds.userId, userId))).toEqual(
      []
    );
    expect(subscription).toEqual({
      id: subscription.id,
      type: "collection",
      url: null,
      title: "Reading",
      originalTitle: "Reading",
      description: null,
      siteUrl: null,
      subscribedAt: expect.any(Date),
      unreadCount: 0,
      tags: [],
      fetchFullContent: false,
    });
  });

  it("lists and gets one with its own type and name", async () => {
    const { userId, collectionId } = await setup();
    const caller = createCaller(await createAuthContext(userId));
    const expected = {
      id: collectionId,
      type: "collection",
      title: "Reading",
      originalTitle: "Reading",
      url: null,
      unreadCount: 1,
      tags: [],
    };

    expect((await caller.subscriptions.list({ type: "collection" })).items).toEqual([
      expect.objectContaining(expected),
    ]);
    expect((await caller.subscriptions.list({ uncategorized: true })).items).toContainEqual(
      expect.objectContaining(expected)
    );
    expect(await caller.subscriptions.get({ id: collectionId })).toMatchObject(expected);
  });

  it("renames, tags and deletes one", async () => {
    const { userId, collectionId } = await setup();
    const caller = createCaller(await createAuthContext(userId));
    const tagId = await createTestTag(userId);

    expect(await caller.subscriptions.update({ id: collectionId, customTitle: "Later" })).toEqual(
      expect.objectContaining({
        id: collectionId,
        type: "collection",
        title: "Later",
        originalTitle: "Later",
        url: null,
      })
    );
    await caller.subscriptions.setTags({ id: collectionId, tagIds: [tagId] });
    expect((await caller.subscriptions.list({ tagId })).items.map((s) => s.id)).toEqual([
      collectionId,
    ]);
    expect((await caller.subscriptions.delete({ id: collectionId })).success).toBe(true);
    expect((await caller.subscriptions.list({})).items.map((s) => s.id)).not.toContain(
      collectionId
    );
  });

  it("counts and lists its entries", async () => {
    const { userId, entryId, collectionId } = await setup();
    const caller = createCaller(await createAuthContext(userId));
    const tagId = await createTestTag(userId, { subscriptionIds: [collectionId] });

    expect((await caller.entries.list({ subscriptionId: collectionId })).items).toEqual([
      expect.objectContaining({ id: entryId }),
    ]);
    expect(await caller.entries.count({ subscriptionId: collectionId })).toEqual({ unread: 1 });
    expect((await caller.tags.list()).items).toEqual([
      expect.objectContaining({ id: tagId, feedCount: 1, unreadCount: 1 }),
    ]);
  });

  it("is a Wallabag tag, left out of Google Reader's subscriptions and OPML", async () => {
    const { userId, sourceId, collectionId } = await setup();
    const [{ greaderStreamId }] = await db
      .select({ greaderStreamId: subscriptions.greaderStreamId })
      .from(subscriptions)
      .where(eq(subscriptions.id, collectionId));

    expect(await listWallabagTags(db, userId)).toEqual([
      expect.objectContaining({ id: Number(greaderStreamId), label: "Reading" }),
    ]);
    expect((await listGreaderSubscriptions(db, userId)).map((s) => s.id)).toEqual([sourceId]);
    expect((await exportSubscriptionsOpml(db, userId)).feedCount).toBe(1);
  });

  it("syncs as subscription_created with its name and no feed data", async () => {
    const { userId, collectionId } = await setup();
    const caller = createCaller(await createAuthContext(userId));
    const longAgo = new Date("2020-01-01T00:00:00Z").toISOString();

    const { events } = await caller.sync.events({ cursors: { subscriptions: longAgo } });

    expect(
      events.find((e) => e.type === "subscription_created" && e.subscriptionId === collectionId)
    ).toMatchObject({
      subscription: {
        id: collectionId,
        feedId: collectionId,
        customTitle: "Reading",
        unreadCount: 1,
      },
      feed: {
        id: collectionId,
        type: "collection",
        url: null,
        title: "Reading",
        description: null,
        siteUrl: null,
      },
    });
  });

  it("streams a new one's events alongside a web feed's over SSE", async () => {
    const { userId, feedId, entryId } = await setup();
    const caller = createCaller(await createAuthContext(userId));
    const stream = await openSseStream(userId);
    let laterId = "";

    try {
      // The web feed's channel is still followed.
      await publishUntil(
        () => publishNewEntry(feedId, entryId, new Date(), undefined),
        () => stream.events("new_entry").length > 0
      );
      laterId = (await caller.collections.create({ name: "Later" })).subscription.id;
      await stream.waitFor("subscription_created", (e) => e.subscriptionId === laterId);
      expect(await unsubscribe(db, userId, laterId)).not.toBeNull();
      await stream.waitFor("subscription_deleted", (e) => e.subscriptionId === laterId);
    } finally {
      await stream.close();
    }

    // Released Android builds (up to v0.5.1) require subscription.feedId and
    // feed.id; they carry the subscription id. The internal feedId is stripped.
    expect(stream.events("subscription_created")).toEqual([
      {
        type: "subscription_created",
        userId,
        subscriptionId: laterId,
        timestamp: expect.any(String),
        updatedAt: expect.any(String),
        subscription: {
          id: laterId,
          feedId: laterId,
          customTitle: "Later",
          subscribedAt: expect.any(String),
          unreadCount: 0,
          tags: [],
        },
        feed: {
          id: laterId,
          type: "collection",
          url: null,
          title: "Later",
          description: null,
          siteUrl: null,
        },
        counts: expect.any(Object),
      },
    ]);
  });

  it("doesn't stop deleting a user from removing their orphaned feeds", async () => {
    const { userId, feedId } = await setup();
    const otherUserId = await createTestUser();
    await newCollection(otherUserId, "Other");

    await deleteUser(db, userId);

    expect(await db.select().from(feeds).where(eq(feeds.id, feedId))).toEqual([]);
  });
});

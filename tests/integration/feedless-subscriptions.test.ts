/**
 * A subscription may have no feed, and a collection never has one (#1846).
 * Every read takes a subscription's type and name from the subscription
 * itself, and clients still get the fields released apps require.
 */

import { readFileSync } from "node:fs";
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { eq, sql } from "drizzle-orm";
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
import { generateUuidv7 } from "../../src/lib/uuidv7";

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

describe("migration 0131: collections drop their feeds", () => {
  beforeEach(cleanup);
  afterAll(cleanup);

  const migration = readFileSync(
    new URL("../../migrations/0131_collections_feedless.sql", import.meta.url),
    "utf8"
  );

  /**
   * Gives the collection a feed of its own (with a fetch job, and optionally
   * an entry), as releases before 0131 created them, then runs the migration
   * in the same transaction. The schema now forbids those rows, so its checks
   * are first put back as they were; the migration replaces them. Raw
   * inserts: the factories can't build rows the current schema rejects.
   */
  async function migrateFromFeed(
    userId: string,
    collectionId: string,
    { strayEntry = false }: { strayEntry?: boolean } = {}
  ): Promise<{ legacyFeedId: string; jobId: string }> {
    const legacyFeedId = generateUuidv7();
    const jobId = generateUuidv7();
    await db.transaction(async (tx) => {
      await tx.execute(sql`
        ALTER TABLE subscriptions DROP CONSTRAINT subscriptions_collection_feedless;
        ALTER TABLE feeds DROP CONSTRAINT feeds_type_not_collection;
        ALTER TABLE feeds DROP CONSTRAINT feed_type_user_id;
        ALTER TABLE feeds ADD CONSTRAINT feed_type_user_id
          CHECK ((type IN ('email', 'saved', 'collection')) = (user_id IS NOT NULL))`);
      await tx.execute(sql`
        INSERT INTO feeds (id, type, user_id, title)
        VALUES (${legacyFeedId}, 'collection', ${userId}, 'Reading')`);
      if (strayEntry) {
        await tx.execute(sql`
          INSERT INTO entries (id, feed_id, type, guid, fetched_at, content_hash)
          VALUES (${generateUuidv7()}, ${legacyFeedId}, 'saved', 'stray', now(), 'hash')`);
      }
      await tx
        .update(subscriptions)
        .set({ feedId: legacyFeedId })
        .where(eq(subscriptions.id, collectionId));
      await tx
        .insert(jobs)
        .values({ id: jobId, type: "fetch_feed", payload: { feedId: legacyFeedId } });
      await tx.execute(sql.raw(migration));
    });
    return { legacyFeedId, jobId };
  }

  it("deletes their feeds, and they keep working without", async () => {
    const { userId, feedId, sourceId, entryId, collectionId } = await setup();

    const { legacyFeedId, jobId } = await migrateFromFeed(userId, collectionId);

    expect(await db.select().from(feeds).where(eq(feeds.id, legacyFeedId))).toEqual([]);
    expect(await db.select().from(jobs).where(eq(jobs.id, jobId))).toEqual([]);
    expect(
      await db
        .select({ id: subscriptions.id, feedId: subscriptions.feedId })
        .from(subscriptions)
        .where(eq(subscriptions.userId, userId))
        .orderBy(subscriptions.id)
    ).toEqual([
      { id: sourceId, feedId },
      { id: collectionId, feedId: null },
    ]);
    const caller = createCaller(await createAuthContext(userId));
    expect(await caller.subscriptions.get({ id: collectionId })).toMatchObject({
      type: "collection",
      title: "Reading",
      unreadCount: 1,
    });
    expect(
      (await caller.entries.list({ subscriptionId: collectionId })).items.map((e) => e.id)
    ).toEqual([entryId]);
    // The checks now forbid giving a collection a feed, or a feed that type.
    await expect(
      db.update(subscriptions).set({ feedId }).where(eq(subscriptions.id, collectionId))
    ).rejects.toMatchObject({ cause: { constraint: "subscriptions_collection_feedless" } });
    await expect(
      db.execute(sql`UPDATE feeds SET type = 'collection' WHERE id = ${feedId}`)
    ).rejects.toMatchObject({ cause: { constraint: "feeds_type_not_collection" } });
  });

  it("stops rather than delete a collection feed's entries", async () => {
    const { userId, collectionId } = await setup();

    await expect(migrateFromFeed(userId, collectionId, { strayEntry: true })).rejects.toMatchObject(
      { cause: { message: expect.stringContaining("a collection feed has entries") } }
    );

    // Rolled back whole: the collection is as it was.
    expect(
      await db
        .select({ feedId: subscriptions.feedId })
        .from(subscriptions)
        .where(eq(subscriptions.id, collectionId))
    ).toEqual([{ feedId: null }]);
  });
});

/**
 * Concurrency tests for the unread counters (#1806): with the lock order in
 * src/server/CLAUDE.md, concurrent writes neither deadlock nor lose a counter
 * update. Each test
 * asserts only what every interleaving guarantees: all calls succeed and the
 * counters match their definition afterwards.
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import pg from "pg";
import { and, eq, inArray } from "drizzle-orm";
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
import { markEntriesRead } from "../../src/server/services/entries";
import {
  createSubscription,
  setSubscriptionTags,
  unsubscribe,
} from "../../src/server/services/subscriptions";
import { deleteTag } from "../../src/server/services/tags";
import { migrateSubscriptionsToExistingFeed } from "../../src/server/jobs/handlers/fetch-feed";
import { createUserEntriesForFeed } from "../../src/server/feed/entry-processor";
import { reconcileCounters } from "../../src/server/services/reconcile-counters";
import {
  createTestEntry,
  createTestFeed,
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
  await db.delete(feeds);
  await db.delete(users);
}

async function expectNoDrift(): Promise<void> {
  expect(await reconcileCounters(db)).toEqual({
    userEntriesFixed: 0,
    subscriptionsFixed: 0,
    usersFixed: 0,
    tagsFixed: 0,
  });
}

async function expectAllFulfilled(promises: Array<Promise<unknown>>): Promise<void> {
  const results = await Promise.allSettled(promises);
  expect(results.filter((r) => r.status === "rejected")).toEqual([]);
}

async function createUsers(count: number): Promise<string[]> {
  const userIds: string[] = [];
  for (let i = 0; i < count; i++) userIds.push(await createTestUser());
  return userIds;
}

/** Creates `count` feeds every user subscribes to. */
async function subscribeAll(userIds: string[], count: number): Promise<string[]> {
  const feedIds: string[] = [];
  for (let i = 0; i < count; i++) {
    const feedId = await createTestFeed();
    for (const userId of userIds) await createTestSubscription(userId, feedId);
    feedIds.push(feedId);
  }
  return feedIds;
}

async function feedWithEntries(userId: string, count: number) {
  const feedId = await createTestFeed();
  const subscriptionId = await createTestSubscription(userId, feedId);
  const entryIds: string[] = [];
  for (let i = 0; i < count; i++) {
    entryIds.push(await createTestEntry(feedId, { userIds: [userId] }));
  }
  return { subscriptionId, entryIds };
}

describe("unread counters under concurrent writes", () => {
  beforeEach(cleanup);
  afterAll(cleanup);

  it("concurrent adds to one collection all succeed", async () => {
    const userId = await createTestUser();
    const { entryIds } = await feedWithEntries(userId, 20);
    const { subscription } = await createCollection(db, userId, "C");

    await expectAllFulfilled(
      entryIds.map((id) => addEntriesToCollection(db, userId, subscription.id, [id]))
    );
    await expectNoDrift();
  });

  it("adding articles to a collection while they're read all succeeds", async () => {
    const userId = await createTestUser();
    const { entryIds } = await feedWithEntries(userId, 10);
    const { subscription } = await createCollection(db, userId, "C");

    await expectAllFulfilled(
      entryIds.flatMap((id) => [
        addEntriesToCollection(db, userId, subscription.id, [id]),
        markEntriesRead(db, userId, [{ id }], true),
      ])
    );
    await expectNoDrift();
  });

  it("deleting tags while their articles are read all succeeds", async () => {
    const userId = await createTestUser();
    const { subscriptionId, entryIds } = await feedWithEntries(userId, 10);
    const tagIds: string[] = [];
    for (let i = 0; i < entryIds.length; i++) {
      tagIds.push(await createTestTag(userId, { subscriptionIds: [subscriptionId] }));
    }

    await expectAllFulfilled(
      entryIds.flatMap((id, i) => [
        deleteTag(db, userId, tagIds[i]),
        markEntriesRead(db, userId, [{ id }], true),
      ])
    );
    await expectNoDrift();
  });

  it("unsubscribing, resubscribing and deleting collections while articles are read all succeeds", async () => {
    // (Un)subscribing moves every member's active_memberships (#1846), so it
    // must lock their rows before the subscription's, like a mark-read.
    const userId = await createTestUser();
    const sources = [await feedWithEntries(userId, 5), await feedWithEntries(userId, 5)];
    const [{ url }] = await db
      .select({ url: feeds.url })
      .from(feeds)
      .innerJoin(subscriptions, eq(subscriptions.feedId, feeds.id))
      .where(eq(subscriptions.id, sources[1].subscriptionId));
    await unsubscribe(db, userId, sources[1].subscriptionId);
    // Starred, so the unsubscribed feed's articles stay visible and readable.
    await db
      .update(userEntries)
      .set({ starred: true })
      .where(
        and(eq(userEntries.userId, userId), inArray(userEntries.entryId, sources[1].entryIds))
      );
    const { subscription } = await createCollection(db, userId, "C");
    const all = sources.flatMap((f) => f.entryIds);
    await addEntriesToCollection(db, userId, subscription.id, all);

    await expectAllFulfilled([
      unsubscribe(db, userId, sources[0].subscriptionId),
      createSubscription(db, userId, { url: url! }),
      unsubscribe(db, userId, subscription.id),
      ...all.map((id) => markEntriesRead(db, userId, [{ id }], true)),
    ]);
    await expectNoDrift();
  });

  it("concurrent fan-outs of feeds with shared subscribers all succeed", async () => {
    // Each fan-out is one statement inserting rows for every subscriber. A
    // feed fetches one at a time (one job per feed), so the concurrency is
    // across feeds.
    const userIds = await createUsers(20);
    const feeds = await subscribeAll(userIds, 20);

    await expectAllFulfilled(feeds.map((feedId) => createTestEntry(feedId, { userIds })));
    await expectNoDrift();
  });

  it("a redirect merge of many users while their other feeds fan out all succeeds", async () => {
    const userIds = await createUsers(20);
    const merged = await createTestFeed();
    // Subscribe in reverse id order, so the merge meets the users in an order
    // other than their id order.
    for (const userId of [...userIds].reverse()) await createTestSubscription(userId, merged);
    const live = await subscribeAll(userIds, 10);
    for (const userId of userIds) {
      await createTestTag(userId, {
        subscriptionIds: (
          await db
            .select({ id: subscriptions.id })
            .from(subscriptions)
            .where(and(eq(subscriptions.userId, userId), eq(subscriptions.feedId, merged)))
        ).map((r) => r.id),
      });
    }
    await createTestEntry(merged, { userIds });
    const [oldFeed] = await db.select().from(feeds).where(eq(feeds.id, merged));
    const [newFeed] = await db
      .select()
      .from(feeds)
      .where(eq(feeds.id, await createTestFeed()));

    const merge = migrateSubscriptionsToExistingFeed(oldFeed, newFeed);
    const fanouts = live.map((feedId) => createTestEntry(feedId, { userIds }));
    await expectAllFulfilled([merge, ...fanouts]);
    await expectNoDrift();
  });

  it.each([false, true])(
    "a fan-out racing an unsubscribe leaves the new article hidden (read: %s)",
    async (read) => {
      // The fan-out picks the subscription while the unsubscribe is still
      // uncommitted, so the unsubscribe's trigger can't see the new row: the
      // membership trigger must notice the unsubscribe itself, even when
      // nothing it inserts is unread (a backfill).
      const userId = await createTestUser();
      const feedId = await createTestFeed();
      const subscriptionId = await createTestSubscription(userId, feedId);
      const entryId = await createTestEntry(feedId, { isBackfill: read });

      const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
      await client.connect();
      try {
        await client.query("BEGIN");
        await client.query("UPDATE subscriptions SET unsubscribed_at = now() WHERE id = $1", [
          subscriptionId,
        ]);
        const fanout = createUserEntriesForFeed(feedId, [entryId]);
        await new Promise((resolve) => setTimeout(resolve, 200));
        await client.query("COMMIT");
        await fanout;
      } finally {
        await client.end();
      }

      const [row] = await db
        .select({ activeMemberships: userEntries.activeMemberships })
        .from(userEntries)
        .where(and(eq(userEntries.userId, userId), eq(userEntries.entryId, entryId)));
      expect(row).toEqual({ activeMemberships: 0 });
      await expectNoDrift();
    }
  );

  it("a recompute waits for a statement that moves articles between tags", async () => {
    // Read one article of a T1 feed and unread one of a T2 feed in one
    // statement: All and Uncategorized don't change, only T1 and T2 do. A
    // recompute for the same user (tagging a collection) must still wait for
    // it, or it computes T1 from counters that predate the statement and
    // overwrites the statement's change when it commits.
    const userId = await createTestUser();
    const t1 = await feedWithEntries(userId, 1);
    const t2 = await feedWithEntries(userId, 1);
    const t1Tag = await createTestTag(userId, { subscriptionIds: [t1.subscriptionId] });
    await createTestTag(userId, { subscriptionIds: [t2.subscriptionId] });
    await markEntriesRead(db, userId, [{ id: t2.entryIds[0] }], true);
    const other = await feedWithEntries(userId, 1);
    const { subscription } = await createCollection(db, userId, "C");
    await addEntriesToCollection(db, userId, subscription.id, other.entryIds);

    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "UPDATE user_entries SET read = NOT read WHERE user_id = $1 AND entry_id = ANY($2)",
        [userId, [t1.entryIds[0], t2.entryIds[0]]]
      );
      const recompute = setSubscriptionTags(db, userId, subscription.id, [t1Tag]);
      await new Promise((resolve) => setTimeout(resolve, 200));
      await client.query("COMMIT");
      await recompute;
    } finally {
      await client.end();
    }

    await expectNoDrift();
  });
});

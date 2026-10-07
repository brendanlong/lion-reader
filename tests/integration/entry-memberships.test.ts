/**
 * Entries name the subscriptions holding them (#1846 phase 5): `subscriptionId`
 * is the origin (a web, email or saved membership, an active one first) and
 * `subscriptionIds` every active subscription holding the entry, on lists,
 * single reads, write results and delta sync alike.
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../../src/server/db";
import {
  collectionEntries,
  entries,
  feeds,
  jobs,
  subscriptions,
  userEntries,
  users,
} from "../../src/server/db/schema";
import { addEntriesToCollection, createCollection } from "../../src/server/services/collections";
import { getEntry, listEntries, markEntriesRead } from "../../src/server/services/entries";
import { uploadArticle } from "../../src/server/services/saved";
import { getSavedSubscriptionId } from "../../src/server/services/subscriptions";
import { migrateSubscriptionsToExistingFeed } from "../../src/server/jobs/handlers/fetch-feed";
import { createCaller } from "../../src/server/trpc/root";
import {
  createAuthContext,
  createTestEntry,
  createTestFeed,
  createTestSubscription,
  createTestUser,
} from "./helpers";

async function cleanup(): Promise<void> {
  await db.delete(collectionEntries);
  await db.delete(userEntries);
  await db.delete(entries);
  await db.delete(subscriptions);
  await db.delete(jobs);
  await db.delete(feeds);
  await db.delete(users);
}

describe("entry memberships (#1846)", () => {
  beforeEach(cleanup);
  afterAll(cleanup);

  it("names the origin and every active subscription holding an entry", async () => {
    const userId = await createTestUser();
    const feedId = await createTestFeed({ title: "Source" });
    const sourceId = await createTestSubscription(userId, feedId);
    const entryId = await createTestEntry(feedId, { userIds: [userId] });
    const kept = (await createCollection(db, userId, "Kept")).subscription.id;
    const gone = (await createCollection(db, userId, "Gone")).subscription.id;
    await addEntriesToCollection(db, userId, kept, [entryId]);
    await addEntriesToCollection(db, userId, gone, [entryId]);
    await createCaller(await createAuthContext(userId)).subscriptions.delete({ id: gone });

    const expected = { subscriptionId: sourceId, subscriptionIds: [sourceId, kept].sort() };
    const { items } = await listEntries(db, { userId, showSpam: false });
    expect(
      items.map((i) => ({ subscriptionId: i.subscriptionId, subscriptionIds: i.subscriptionIds }))
    ).toEqual([expected]);
    expect(await getEntry(db, userId, entryId)).toMatchObject({ ...expected, feedTitle: "Source" });
    expect((await markEntriesRead(db, userId, [{ id: entryId }], true)).entries).toMatchObject([
      expected,
    ]);
    // A deleted collection's memberships stay but no list shows them.
    expect(await listEntries(db, { userId, subscriptionId: gone, showSpam: false })).toEqual({
      items: [],
      nextCursor: undefined,
    });
  });

  it("makes the survivor a merged article's origin, ahead of the subscription it left", async () => {
    const userId = await createTestUser();
    const oldFeedId = await createTestFeed();
    const newFeedId = await createTestFeed();
    await createTestSubscription(userId, oldFeedId);
    const entryId = await createTestEntry(oldFeedId, { userIds: [userId] });
    const [oldFeed] = await db.select().from(feeds).where(eq(feeds.id, oldFeedId));
    const [newFeed] = await db.select().from(feeds).where(eq(feeds.id, newFeedId));

    await migrateSubscriptionsToExistingFeed(oldFeed, newFeed);

    const [survivor] = await db
      .select({ id: subscriptions.id })
      .from(subscriptions)
      .where(and(eq(subscriptions.userId, userId), eq(subscriptions.feedId, newFeedId)));
    expect(await getEntry(db, userId, entryId)).toMatchObject({
      subscriptionId: survivor.id,
      subscriptionIds: [survivor.id],
    });
  });

  it("gives a saved article the saved subscription, which the subscription list names", async () => {
    const userId = await createTestUser();
    const { id } = await uploadArticle(db, userId, { content: "Body", title: "Kept" });
    const savedId = await getSavedSubscriptionId(db, userId);
    const caller = createCaller(await createAuthContext(userId));

    expect(savedId).not.toBeNull();
    expect(await caller.entries.get({ id })).toMatchObject({
      entry: { subscriptionId: savedId, subscriptionIds: [savedId], feedTitle: "Saved Articles" },
    });
    const list = await caller.subscriptions.list();
    expect(list.savedSubscriptionId).toBe(savedId);
    expect(list.items).toEqual([]);
  });

  it("pages one subscription's list, and Saved, through its own timeline", async () => {
    const userId = await createTestUser();
    const feedId = await createTestFeed();
    const sourceId = await createTestSubscription(userId, feedId);
    const base = Date.now();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const fetchedAt = new Date(base - i * 1000);
      ids.push(await createTestEntry(feedId, { userIds: [userId], fetchedAt }));
    }
    // Another feed's newer article stays out of the subscription's list.
    await createTestEntry(await createTestFeed(), { userIds: [userId] });
    await uploadArticle(db, userId, { content: "One", title: "One" });

    const paged: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await listEntries(db, {
        userId,
        subscriptionId: sourceId,
        limit: 1,
        cursor,
        showSpam: false,
      });
      paged.push(...page.items.map((i) => i.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(paged).toEqual(ids);

    const saved = await listEntries(db, { userId, type: "saved", showSpam: false });
    expect(saved.items.map((i) => i.type)).toEqual(["saved"]);
  });

  it("syncs memberships with entry events", async () => {
    const userId = await createTestUser();
    const feedId = await createTestFeed();
    const sourceId = await createTestSubscription(userId, feedId);
    const since = new Date(Date.now() - 1000).toISOString();
    const entryId = await createTestEntry(feedId, { userIds: [userId] });
    const collection = (await createCollection(db, userId, "C")).subscription.id;
    await addEntriesToCollection(db, userId, collection, [entryId]);

    const { events } = await createCaller(await createAuthContext(userId)).sync.events({
      cursors: { entries: since },
    });
    expect(events.find((e) => e.type === "new_entry")).toMatchObject({
      subscriptionId: sourceId,
      subscriptionIds: [sourceId, collection].sort(),
    });
  });
});

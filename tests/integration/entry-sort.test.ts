/**
 * Sorting entry lists by score and by a collection's position (#2064): the
 * order each direction gives, which sorts a list says it can use, and the
 * writes that set them. `list-page-bounds.test.ts` holds the same queries to
 * their index ranges and checks cursor pages against the whole list.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db } from "../../src/server/db";
import { feeds, userEntries, users } from "../../src/server/db/schema";
import { listEntries, type ListEntriesParams } from "../../src/server/services/entries";
import { setEntryScores } from "../../src/server/services/entry-scores";
import {
  addEntriesToCollection,
  createCollection,
  setCollectionPositions,
} from "../../src/server/services/collections";
import { markEntriesRead } from "../../src/server/services/entry-state";
import {
  createTestEntryBatch,
  createTestFeed,
  createTestSubscription,
  createTestTag,
  createTestUser,
  createTestUserEntries,
} from "./helpers";

let userId: string;
let otherUserId: string;
let feedId: string;
let subscriptionId: string;
let tagId: string;
/** Six entries, oldest first. */
let ids: string[];

async function list(params: Partial<ListEntriesParams>) {
  return listEntries(db, { userId, showSpam: false, limit: 100, ...params });
}

async function order(params: Partial<ListEntriesParams>): Promise<string[]> {
  return (await list(params)).items.map((item) => item.id);
}

beforeAll(async () => {
  userId = await createTestUser({ emailPrefix: "entry-sort" });
  otherUserId = await createTestUser({ emailPrefix: "entry-sort-other" });
  feedId = await createTestFeed();
  subscriptionId = await createTestSubscription(userId, feedId);
  tagId = await createTestTag(userId, { subscriptionIds: [subscriptionId] });
  ids = await createTestEntryBatch(feedId, 6, { start: new Date("2025-01-01T00:00:00Z") });
  await createTestUserEntries(ids.map((entryId) => ({ userId, entryId })));
});

afterAll(async () => {
  await db.delete(users).where(inArray(users.id, [userId, otherUserId]));
  await db.delete(feeds).where(eq(feeds.id, feedId));
});

describe("sorting by score", () => {
  beforeAll(async () => {
    // Two tie at 5, one is negative, three have none.
    await setEntryScores(db, userId, [
      { entryId: ids[1], score: 5 },
      { entryId: ids[4], score: 5 },
      { entryId: ids[2], score: -1 },
      { entryId: ids[3], score: 9 },
    ]);
  });

  it("lists highest first, ties newest first, then the unscored newest first", async () => {
    expect(await order({ sortBy: "score" })).toEqual([
      ids[3],
      ids[4],
      ids[1],
      ids[2],
      ids[5],
      ids[0],
    ]);
  });

  it("lists lowest first, ties oldest first, then the unscored still newest first", async () => {
    expect(await order({ sortBy: "score", sortOrder: "lowest" })).toEqual([
      ids[2],
      ids[1],
      ids[4],
      ids[3],
      ids[5],
      ids[0],
    ]);
  });

  it("orders a tag's and a subscription's lists the same way", async () => {
    const all = await order({ sortBy: "score" });
    expect(await order({ tagId, sortBy: "score" })).toEqual(all);
    expect(await order({ subscriptionId, sortBy: "score" })).toEqual(all);
  });

  it("pages across the change from scored to unscored entries", async () => {
    const pages: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await list({ sortBy: "score", sortOrder: "lowest", limit: 2, cursor });
      pages.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(pages).toEqual(await order({ sortBy: "score", sortOrder: "lowest" }));
  });

  it("returns each entry's score", async () => {
    const items = (await list({ sortBy: "score" })).items;
    expect(items.map((item) => item.score)).toEqual([9, 5, 5, -1, null, null]);
  });

  it("rejects another field's direction", async () => {
    await expect(list({ sortBy: "score", sortOrder: "newest" })).rejects.toThrow();
  });
});

describe("sorting a collection by position", () => {
  let first: string;
  let second: string;

  beforeAll(async () => {
    first = (await createCollection(db, userId, "First")).subscription.id;
    second = (await createCollection(db, userId, "Second")).subscription.id;
    await addEntriesToCollection(db, userId, first, ids);
    await addEntriesToCollection(db, userId, second, ids);
    // The same article has its own place in each collection.
    await setCollectionPositions(db, userId, first, [
      { entryId: ids[0], position: 2 },
      { entryId: ids[5], position: 1 },
      { entryId: ids[2], position: 2 },
    ]);
    await setCollectionPositions(db, userId, second, [{ entryId: ids[0], position: 7 }]);
  });

  it("lists first first, ties oldest first, then the unpositioned newest first", async () => {
    expect(await order({ subscriptionId: first, sortBy: "position" })).toEqual([
      ids[5],
      ids[0],
      ids[2],
      ids[4],
      ids[3],
      ids[1],
    ]);
    expect(await order({ subscriptionId: second, sortBy: "position" })).toEqual([
      ids[0],
      ids[5],
      ids[4],
      ids[3],
      ids[2],
      ids[1],
    ]);
  });

  it("lists last first, ties newest first, then the unpositioned newest first", async () => {
    expect(await order({ subscriptionId: first, sortBy: "position", sortOrder: "last" })).toEqual([
      ids[2],
      ids[0],
      ids[5],
      ids[4],
      ids[3],
      ids[1],
    ]);
  });

  it("sorts only one subscription's list", async () => {
    await expect(list({ sortBy: "position" })).rejects.toThrow();
    await expect(list({ tagId, sortBy: "position" })).rejects.toThrow();
  });

  it("can't be paged by offset", async () => {
    await expect(list({ subscriptionId: first, sortBy: "position", offset: 2 })).rejects.toThrow();
  });
});

describe("sortable", () => {
  it("says which sorts the list has values for, with its filters", async () => {
    const otherFeed = await createTestFeed();
    const otherSubscription = await createTestSubscription(userId, otherFeed);
    const [unscored] = await createTestEntryBatch(otherFeed, 1, { start: new Date() });
    await createTestUserEntries({ userId, entryId: unscored });
    const collection = (await createCollection(db, userId, "Sortable")).subscription.id;
    await addEntriesToCollection(db, userId, collection, [ids[3], unscored]);
    try {
      expect((await list({})).sortable).toEqual({ score: true, position: false });
      expect((await list({ subscriptionId: otherSubscription })).sortable).toEqual({
        score: false,
        position: false,
      });
      expect((await list({ subscriptionId: collection })).sortable).toEqual({
        score: true,
        position: false,
      });

      await setCollectionPositions(db, userId, collection, [{ entryId: unscored, position: 1 }]);
      expect((await list({ subscriptionId: collection })).sortable).toEqual({
        score: true,
        position: true,
      });

      // Read, the only scored member leaves the unread list's scores.
      await markEntriesRead(db, userId, [{ id: ids[3] }], true);
      expect((await list({ subscriptionId: collection, unreadOnly: true })).sortable).toEqual({
        score: false,
        position: true,
      });
      await markEntriesRead(db, userId, [{ id: ids[3] }], false);
    } finally {
      await db.delete(feeds).where(eq(feeds.id, otherFeed));
    }
  });

  it("is on the first page only, and not on Recently Read or a search", async () => {
    const first = await list({ limit: 1 });
    expect(first.sortable).toBeDefined();
    expect((await list({ limit: 1, cursor: first.nextCursor })).sortable).toBeUndefined();
    expect((await list({ sortBy: "readChanged" })).sortable).toBeUndefined();
    expect((await list({ query: "entry" })).sortable).toBeUndefined();
  });
});

describe("setEntryScores", () => {
  it("reports what changed and what the user can't see", async () => {
    const [hidden] = await createTestEntryBatch(feedId, 1, { start: new Date() });
    await createTestUserEntries({ userId: otherUserId, entryId: hidden });
    await setEntryScores(db, userId, [{ entryId: ids[0], score: 1 }]);
    const [before] = await db
      .select({ updatedAt: userEntries.updatedAt })
      .from(userEntries)
      .where(eq(userEntries.entryId, ids[0]));

    const result = await setEntryScores(db, userId, [
      { entryId: ids[0], score: 1 },
      { entryId: ids[5], score: 3 },
      { entryId: ids[5], score: 4 },
      { entryId: hidden, score: 2 },
    ]);
    expect(result).toEqual({
      changed: [{ entryId: ids[5], score: 4 }],
      notFoundIds: [hidden],
    });
    // A re-assert isn't a change for delta sync.
    const [after] = await db
      .select({ updatedAt: userEntries.updatedAt })
      .from(userEntries)
      .where(eq(userEntries.entryId, ids[0]));
    expect(after.updatedAt).toEqual(before.updatedAt);

    const [otherRow] = await db
      .select({ score: userEntries.score })
      .from(userEntries)
      .where(eq(userEntries.entryId, hidden));
    expect(otherRow.score).toBeNull();

    await setEntryScores(db, userId, [
      { entryId: ids[0], score: null },
      { entryId: ids[5], score: null },
    ]);
  });

  it("rejects a score that isn't a finite number", async () => {
    await expect(
      setEntryScores(db, userId, [{ entryId: ids[0], score: Number.POSITIVE_INFINITY }])
    ).rejects.toThrow();
  });
});

describe("setCollectionPositions", () => {
  it("skips articles outside the collection and reports them", async () => {
    const collection = (await createCollection(db, userId, "Partial")).subscription.id;
    await addEntriesToCollection(db, userId, collection, [ids[0]]);
    expect(
      await setCollectionPositions(db, userId, collection, [
        { entryId: ids[0], position: 1 },
        { entryId: ids[1], position: 2 },
      ])
    ).toEqual({ changedIds: [ids[0]], notInCollectionIds: [ids[1]] });
    expect(
      await setCollectionPositions(db, userId, collection, [{ entryId: ids[0], position: 1 }])
    ).toEqual({ changedIds: [], notInCollectionIds: [] });
  });

  it("rejects another user's collection", async () => {
    const theirs = (await createCollection(db, otherUserId, "Theirs")).subscription.id;
    await expect(
      setCollectionPositions(db, userId, theirs, [{ entryId: ids[0], position: 1 }])
    ).rejects.toThrow();
  });
});

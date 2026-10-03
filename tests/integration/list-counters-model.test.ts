/**
 * Randomized model test for the unread counters (#1806).
 *
 * Runs seeded random sequences of the operations that move counters — read,
 * star, collection membership, tagging, unsubscribing, new and deleted
 * articles, mark-all-read, deleting tags and collections — through the
 * services the app calls. After every step it checks that:
 *   1. the reconcile job, which recomputes every counter from its definition,
 *      finds nothing to fix, and
 *   2. every badge equals the number of unread articles its list shows (tag,
 *      Uncategorized, each subscription, All).
 * Interleavings that hand-written tests miss (an article reaching a tag through
 * both its feed and a collection, retagging while members are unread, ...)
 * come up here. A failure prints the seed and step to replay.
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { and, eq, isNull, sql } from "drizzle-orm";
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
import {
  addEntriesToCollection,
  createCollection,
  removeEntriesFromCollection,
} from "../../src/server/services/collections";
import {
  countEntries,
  markAllEntriesRead,
  markEntriesRead,
  updateEntryStarred,
} from "../../src/server/services/entries";
import { setSubscriptionTags } from "../../src/server/services/subscriptions";
import { deleteTag } from "../../src/server/services/tags";
import { deleteSavedArticle, uploadArticle } from "../../src/server/services/saved";
import { reconcileCounters } from "../../src/server/services/reconcile-counters";
import { createCaller } from "../../src/server/trpc/root";
import {
  createAuthContext,
  createTestEntry,
  createTestFeed,
  createTestSubscription,
  createTestTag,
  createTestUser,
} from "./helpers";

const STEPS = 150;
const SEEDS = [1, 2, 3];

/** mulberry32: small seeded PRNG so failures replay exactly. */
function prng(seed: number) {
  let a = seed;
  const next = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    pick<T>(items: T[]): T {
      return items[Math.floor(next() * items.length)];
    },
    chance: (p: number) => next() < p,
  };
}

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

interface World {
  userId: string;
  feeds: Array<{ feedId: string; subscriptionId: string }>;
  collections: string[];
  tagIds: string[];
  savedIds: string[];
}

async function createWorld(): Promise<World> {
  const userId = await createTestUser();
  const world: World = { userId, feeds: [], collections: [], tagIds: [], savedIds: [] };
  for (let i = 0; i < 3; i++) {
    const feedId = await createTestFeed();
    const subscriptionId = await createTestSubscription(userId, feedId);
    world.feeds.push({ feedId, subscriptionId });
    for (let j = 0; j < 4; j++) await createTestEntry(feedId, { userIds: [userId] });
  }
  for (let i = 0; i < 2; i++) {
    world.collections.push((await createCollection(db, userId, `C${i}`)).subscription.id);
  }
  for (let i = 0; i < 2; i++) world.tagIds.push(await createTestTag(userId));
  for (let i = 0; i < 2; i++) {
    world.savedIds.push((await uploadArticle(db, userId, { content: "x", title: `S${i}` })).id);
  }
  return world;
}

async function visibleEntryIds(userId: string): Promise<string[]> {
  const rows = await db.execute<{ id: string }>(
    sql`SELECT id FROM visible_entries WHERE user_id = ${userId}`
  );
  return rows.rows.map((r) => r.id);
}

async function activeSubscriptionIds(userId: string): Promise<string[]> {
  const rows = await db
    .select({ id: subscriptions.id })
    .from(subscriptions)
    .where(and(eq(subscriptions.userId, userId), isNull(subscriptions.unsubscribedAt)));
  return rows.map((r) => r.id);
}

async function liveTagIds(userId: string): Promise<string[]> {
  const rows = await db
    .select({ id: tags.id })
    .from(tags)
    .where(and(eq(tags.userId, userId), isNull(tags.deletedAt)));
  return rows.map((r) => r.id);
}

type Op = (world: World, rng: ReturnType<typeof prng>) => Promise<string>;

const OPS: Array<[number, Op]> = [
  [
    6,
    async (w, rng) => {
      const id = rng.pick(await visibleEntryIds(w.userId));
      if (!id) return "read: nothing visible";
      const read = rng.chance(0.6);
      await markEntriesRead(db, w.userId, [{ id }], read);
      return `${read ? "read" : "unread"} ${id}`;
    },
  ],
  [
    3,
    async (w, rng) => {
      const id = rng.pick(await visibleEntryIds(w.userId));
      if (!id) return "star: nothing visible";
      const starred = rng.chance(0.5);
      await updateEntryStarred(db, w.userId, id, starred);
      return `${starred ? "star" : "unstar"} ${id}`;
    },
  ],
  [
    5,
    async (w, rng) => {
      const active = new Set(await activeSubscriptionIds(w.userId));
      const collection = rng.pick(w.collections.filter((c) => active.has(c)));
      const id = rng.pick(await visibleEntryIds(w.userId));
      if (!collection || !id) return "add: nothing to add";
      if (rng.chance(0.65)) {
        await addEntriesToCollection(db, w.userId, collection, [id]);
        return `add ${id} to ${collection}`;
      }
      await removeEntriesFromCollection(db, w.userId, collection, [id]);
      return `remove ${id} from ${collection}`;
    },
  ],
  [
    4,
    async (w, rng) => {
      const sub = rng.pick(await activeSubscriptionIds(w.userId));
      const live = await liveTagIds(w.userId);
      const tagIds = live.filter(() => rng.chance(0.6));
      await setSubscriptionTags(db, w.userId, sub, tagIds);
      return `tag ${sub} with [${tagIds.join(",")}]`;
    },
  ],
  [
    2,
    async (w, rng) => {
      const feed = rng.pick(w.feeds);
      const active = (await activeSubscriptionIds(w.userId)).includes(feed.subscriptionId);
      if (active) {
        // What the unsubscribe paths do: drop the tags, then soft-delete.
        await createCaller(await createAuthContext(w.userId)).subscriptions.delete({
          id: feed.subscriptionId,
        });
        return `unsubscribe ${feed.subscriptionId}`;
      }
      await db
        .update(subscriptions)
        .set({ unsubscribedAt: null })
        .where(eq(subscriptions.id, feed.subscriptionId));
      return `resubscribe ${feed.subscriptionId}`;
    },
  ],
  [
    2,
    async (w, rng) => {
      const feed = rng.pick(w.feeds);
      const active = (await activeSubscriptionIds(w.userId)).includes(feed.subscriptionId);
      if (!active) return "new entry: feed inactive";
      const id = await createTestEntry(feed.feedId, { userIds: [w.userId] });
      return `new entry ${id} in ${feed.subscriptionId}`;
    },
  ],
  [
    1,
    async (w, rng) => {
      if (rng.chance(0.5) && w.savedIds.length > 0) {
        const id = w.savedIds.pop()!;
        await deleteSavedArticle(db, w.userId, id);
        return `delete saved ${id}`;
      }
      const article = await uploadArticle(db, w.userId, { content: "y", title: "New" });
      w.savedIds.push(article.id);
      return `save ${article.id}`;
    },
  ],
  [
    1,
    async (w, rng) => {
      const live = await liveTagIds(w.userId);
      if (rng.chance(0.5) && live.length > 0) {
        const tagId = rng.pick(live);
        await markAllEntriesRead(db, { userId: w.userId, tagId, showSpam: false });
        return `mark tag ${tagId} read`;
      }
      const sub = rng.pick(await activeSubscriptionIds(w.userId));
      await markAllEntriesRead(db, { userId: w.userId, subscriptionId: sub, showSpam: false });
      return `mark ${sub} read`;
    },
  ],
  [
    1,
    async (w, rng) => {
      const live = await liveTagIds(w.userId);
      if (live.length > 1 && rng.chance(0.5)) {
        const tagId = rng.pick(live);
        await deleteTag(db, w.userId, tagId);
        return `delete tag ${tagId}`;
      }
      w.tagIds.push(await createTestTag(w.userId));
      return "create tag";
    },
  ],
  [
    1,
    async (w, rng) => {
      const active = new Set(await activeSubscriptionIds(w.userId));
      const live = w.collections.filter((c) => active.has(c));
      if (live.length > 1 && rng.chance(0.5)) {
        const id = rng.pick(live);
        await createCaller(await createAuthContext(w.userId)).subscriptions.delete({ id });
        return `delete collection ${id}`;
      }
      w.collections.push((await createCollection(db, w.userId, "New")).subscription.id);
      return "create collection";
    },
  ],
];

function pickOp(rng: ReturnType<typeof prng>): Op {
  const weighted = OPS.flatMap(([weight, op]) => Array.from({ length: weight }, () => op));
  return rng.pick(weighted);
}

/** Every badge must match the unread count of the list it labels. */
async function expectBadgesMatchLists(userId: string): Promise<void> {
  const [user] = await db
    .select({
      all: users.allUnreadCount,
      uncategorized: users.uncategorizedUnreadCount,
    })
    .from(users)
    .where(eq(users.id, userId));
  const visibleUnread = await db.execute<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM visible_entries
        WHERE user_id = ${userId} AND NOT read AND NOT is_spam`
  );
  expect(user.all, "All").toBe(visibleUnread.rows[0].n);

  const count = (filter: { tagId?: string; uncategorized?: boolean; subscriptionId?: string }) =>
    countEntries(db, userId, { ...filter, unreadOnly: true }).then((r) => r.unread);
  expect(user.uncategorized, "Uncategorized").toBe(await count({ uncategorized: true }));

  for (const tag of await db
    .select({ id: tags.id, unread: tags.unreadCount })
    .from(tags)
    .where(and(eq(tags.userId, userId), isNull(tags.deletedAt)))) {
    expect(tag.unread, `tag ${tag.id}`).toBe(await count({ tagId: tag.id }));
  }
  for (const sub of await db
    .select({ id: subscriptions.id, unread: subscriptions.unreadCount })
    .from(subscriptions)
    .where(and(eq(subscriptions.userId, userId), isNull(subscriptions.unsubscribedAt)))) {
    expect(sub.unread, `subscription ${sub.id}`).toBe(await count({ subscriptionId: sub.id }));
  }
}

describe("unread counters under random operations", () => {
  beforeEach(cleanup);
  afterAll(cleanup);

  it.each(SEEDS)(
    "stay exact (seed %i)",
    async (seed) => {
      const rng = prng(seed);
      // Two users, so a counter leaking across users shows up as drift.
      const worlds = [await createWorld(), await createWorld()];
      await expectBadgesMatchLists(worlds[0].userId);

      const history: string[] = [];
      for (let step = 0; step < STEPS; step++) {
        const world = rng.pick(worlds);
        history.push(await pickOp(rng)(world, rng));
        const context = `seed ${seed}, step ${step}:\n${history.slice(-5).join("\n")}`;
        expect(await reconcileCounters(db), context).toEqual({
          subscriptionsFixed: 0,
          usersFixed: 0,
          tagsFixed: 0,
        });
        await expectBadgesMatchLists(world.userId);
      }
    },
    120_000
  );
});

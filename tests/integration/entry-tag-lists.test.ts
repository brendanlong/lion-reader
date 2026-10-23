/**
 * Every response and event a client places an entry in its lists from carries
 * the tag lists holding it, read from `tag_entries` (#2126), so clients never
 * derive tag membership from the subscriptions they happen to have loaded.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import Redis from "ioredis";
import { db } from "../../src/server/db";
import {
  entries,
  feeds,
  jobs,
  subscriptions,
  userEntries,
  users,
} from "../../src/server/db/schema";
import { addEntriesToCollection, createCollection } from "../../src/server/services/collections";
import { getUserEventsChannel } from "../../src/server/redis/pubsub";
import { createCaller } from "../../src/server/trpc/root";
import type { TagLists } from "../../src/lib/events/schemas";
import {
  createAuthContext,
  createTestEntry,
  createTestFeed,
  createTestSubscription,
  createTestTag,
  createTestUser,
} from "./helpers";

let subscriber: Redis;

async function cleanup(): Promise<void> {
  await db.delete(userEntries);
  await db.delete(entries);
  await db.delete(subscriptions);
  await db.delete(jobs);
  await db.delete(feeds);
  await db.delete(users);
}

beforeAll(() => {
  subscriber = new Redis(process.env.REDIS_URL!);
});
beforeEach(cleanup);
afterAll(async () => {
  await cleanup();
  await subscriber.quit();
});

const sorted = ({ tagIds, uncategorized }: TagLists): TagLists => ({
  tagIds: [...tagIds].sort(),
  uncategorized,
});

/**
 * An entry whose feed is tagged, in a tagged collection and an untagged one,
 * while another user's tag on the same feed never reaches it.
 */
async function setup() {
  const userId = await createTestUser();
  const feedId = await createTestFeed();
  const sourceId = await createTestSubscription(userId, feedId);
  const entryId = await createTestEntry(feedId, { userIds: [userId] });
  const tagged = (await createCollection(db, userId, "Tagged")).subscription.id;
  const untagged = (await createCollection(db, userId, "Untagged")).subscription.id;
  await addEntriesToCollection(db, userId, tagged, [entryId]);
  await addEntriesToCollection(db, userId, untagged, [entryId]);
  const feedTag = await createTestTag(userId, { subscriptionIds: [sourceId] });
  const collectionTag = await createTestTag(userId, { subscriptionIds: [tagged] });
  const otherUser = await createTestUser();
  await createTestTag(otherUser, {
    subscriptionIds: [await createTestSubscription(otherUser, feedId)],
  });
  const tagLists = { tagIds: [feedTag, collectionTag].sort(), uncategorized: true };
  return { userId, entryId, tagLists, caller: createCaller(await createAuthContext(userId)) };
}

describe("entry tag lists (#2126)", () => {
  it("come with an entry on its list pages, its reads and its state writes", async () => {
    const { entryId, tagLists, caller } = await setup();

    const [listed] = (await caller.entries.list({})).items;
    expect(sorted(listed.tagLists)).toEqual(tagLists);
    expect(sorted((await caller.entries.get({ id: entryId })).entry.tagLists)).toEqual(tagLists);
    const [marked] = (await caller.entries.markRead({ entries: [{ id: entryId }], read: true }))
      .entries;
    expect(sorted(marked.tagLists)).toEqual(tagLists);
  });

  it("come with every entry_state_changed, live and in a catch-up", async () => {
    const { userId, entryId, tagLists, caller } = await setup();
    const since = new Date(Date.now() - 1000).toISOString();
    const channel = getUserEventsChannel(userId);
    await subscriber.subscribe(channel);
    const published = new Promise<{ tagLists: TagLists }>((resolve) => {
      // Setup's own events may still be arriving.
      subscriber.on("message", (ch: string, message: string) => {
        const event = JSON.parse(message);
        if (ch === channel && event.type === "entry_state_changed") resolve(event);
      });
    });

    await caller.entries.markRead({ entries: [{ id: entryId }], read: true });

    expect(sorted((await published).tagLists)).toEqual(tagLists);
    const { events } = await caller.sync.events({ cursors: { entries: since } });
    for (const type of ["new_entry", "entry_state_changed"]) {
      const event = events.find((e) => e.type === type) as { tagLists: TagLists } | undefined;
      expect(event && sorted(event.tagLists)).toEqual(tagLists);
    }
  });
});

/**
 * Integration tests for the SSE event published by mark-all-read.
 *
 * markRead publishes one entry_state_changed per entry, but mark-all-read is
 * unbounded, so it emits a single `mark_all_read` signal carrying the absolute
 * counts, and each client invalidates its entry lists. Published inside the
 * markAllEntriesRead service, so both the tRPC mutation and the Google Reader
 * route notify other tabs. This test subscribes to the user's Redis channel and
 * verifies the mutation publishes it.
 *
 * Uses a real Postgres + Redis via docker-compose.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import Redis from "ioredis";
import { db } from "../../src/server/db";
import { users, feeds, entries, subscriptions, userEntries } from "../../src/server/db/schema";
import { createCaller } from "../../src/server/trpc/root";
import { getUserEventsChannel } from "../../src/server/redis/pubsub";
import { expectNoMessage, subscribeAndDrain, waitForMessage } from "../utils/pubsub";
import { addEntriesToCollection, createCollection } from "../../src/server/services/collections";
import {
  createAuthContext,
  createTestEntry,
  createTestFeed,
  createTestSubscription,
  createTestTag,
  createTestUser,
} from "./helpers";

let subscriber: Redis;

beforeAll(() => {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    throw new Error("REDIS_URL must be set for integration tests");
  }
  subscriber = new Redis(redisUrl);
});

async function cleanup(): Promise<void> {
  await db.delete(userEntries);
  await db.delete(entries);
  await db.delete(subscriptions);
  await db.delete(feeds);
  await db.delete(users);
}

afterAll(async () => {
  await subscriber.quit();
  await cleanup();
});

beforeEach(cleanup);

async function seedUnreadEntries(
  userId: string,
  count: number
): Promise<{ subscriptionId: string; entryIds: string[] }> {
  const now = new Date();
  const feedId = await createTestFeed({ lastFetchedAt: now, lastEntriesUpdatedAt: now });
  const subscriptionId = await createTestSubscription(userId, feedId);

  const entryIds: string[] = [];
  for (let i = 0; i < count; i++) {
    entryIds.push(
      await createTestEntry(feedId, { title: `Entry ${i}`, fetchedAt: now, userIds: [userId] })
    );
  }
  return { subscriptionId, entryIds };
}

describe("entries.markAllRead SSE publishing", () => {
  it("publishes a mark_all_read signal carrying a cursor timestamp and the max marked id", async () => {
    const userId = await createTestUser({ emailPrefix: "mark-all" });
    const { entryIds } = await seedUnreadEntries(userId, 3);

    const channel = getUserEventsChannel(userId);
    await subscriber.subscribe(channel);
    const messagePromise = waitForMessage(subscriber, channel);

    const caller = createCaller(await createAuthContext(userId));
    const result = await caller.entries.markAllRead({});
    expect(result.count).toBe(3);

    const event = JSON.parse(await messagePromise);
    expect(event.type).toBe("mark_all_read");
    // updatedAt is the mark-all-read timestamp used to advance the entries cursor.
    expect(typeof event.updatedAt).toBe("string");
    expect(Number.isNaN(Date.parse(event.updatedAt))).toBe(false);
    // entryId is the LARGEST marked entry id: the client's keyset cursor lands
    // exactly past the marked rows, so a catch-up skips them without also
    // skipping an unrelated entry written in the same millisecond (#1102).
    expect(event.entryId).toBe([...entryIds].sort().at(-1));
  });

  it("publishes no event when nothing was unread", async () => {
    const userId = await createTestUser({ emailPrefix: "mark-all-none" });

    const channel = getUserEventsChannel(userId);
    await subscriber.subscribe(channel);

    await expectNoMessage(subscriber, channel, async () => {
      const caller = createCaller(await createAuthContext(userId));
      const result = await caller.entries.markAllRead({});
      expect(result.count).toBe(0);
    });
  });

  it("returns and publishes the absolute counts of every list it reached", async () => {
    const userId = await createTestUser({ emailPrefix: "mark-all-counts" });
    const { subscriptionId, entryIds } = await seedUnreadEntries(userId, 2);
    const tagId = await createTestTag(userId, { name: "News", subscriptionIds: [subscriptionId] });
    const channel = getUserEventsChannel(userId);
    let collectionId = "";
    // Creating the collection and adding to it publish one event each.
    await subscribeAndDrain(
      subscriber,
      channel,
      async () => {
        collectionId = (await createCollection(db, userId, "Picks")).subscription.id;
        await addEntriesToCollection(db, userId, collectionId, [entryIds[0]]);
      },
      2
    );
    const messagePromise = waitForMessage(subscriber, channel);

    const caller = createCaller(await createAuthContext(userId));
    const { counts } = await caller.entries.markAllRead({});

    expect(counts).toEqual({
      all: { unread: 0 },
      starred: { unread: 0 },
      saved: { unread: 0 },
      subscriptions: expect.arrayContaining([
        { id: subscriptionId, unread: 0, tagIds: [tagId] },
        { id: collectionId, unread: 0, tagIds: [] },
      ]),
      tags: [{ id: tagId, unread: 0 }],
      uncategorized: { unread: 0 },
    });
    expect(counts?.subscriptions).toHaveLength(2);
    expect(JSON.parse(await messagePromise).counts).toEqual(counts);
  });
});

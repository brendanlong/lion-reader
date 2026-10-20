/**
 * Scores and collection positions (#2064) travel with an entry's state: a
 * write publishes `entry_state_changed` carrying them, and delta sync
 * re-delivers the entry with them, so web tabs and the native app keep their
 * own lists in the server's order.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Redis from "ioredis";
import { eq } from "drizzle-orm";
import { db } from "../../src/server/db";
import { feeds, users } from "../../src/server/db/schema";
import { getUserEventsChannel } from "../../src/server/redis/pubsub";
import { setEntryScores } from "../../src/server/services/entry-scores";
import {
  addEntriesToCollection,
  createCollection,
  setCollectionPositions,
} from "../../src/server/services/collections";
import { collectSyncChanges } from "../../src/server/services/sync";
import { subscribeAndDrain, waitForMessage } from "../utils/pubsub";
import { createTestEntry, createTestFeed, createTestSubscription, createTestUser } from "./helpers";

let subscriber: Redis;
let userId: string;
let feedId: string;
let entryId: string;
let collectionId: string;
let channel: string;

beforeAll(async () => {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) throw new Error("REDIS_URL must be set for integration tests");
  subscriber = new Redis(redisUrl);
  userId = await createTestUser({ emailPrefix: "entry-sort-events" });
  feedId = await createTestFeed();
  await createTestSubscription(userId, feedId);
  entryId = await createTestEntry(feedId, { userIds: [userId] });
  channel = getUserEventsChannel(userId);
  await subscribeAndDrain(
    subscriber,
    channel,
    async () => {
      collectionId = (await createCollection(db, userId, "Book")).subscription.id;
      await addEntriesToCollection(db, userId, collectionId, [entryId]);
    },
    2
  );
});

afterAll(async () => {
  await subscriber.quit();
  await db.delete(users).where(eq(users.id, userId));
  await db.delete(feeds).where(eq(feeds.id, feedId));
});

describe("score and position changes", () => {
  it("publish the entry's state with them, and delta sync re-delivers it", async () => {
    const since = new Date().toISOString();

    const scored = waitForMessage(subscriber, channel);
    await setEntryScores(db, userId, [{ entryId, score: 4 }]);
    expect(JSON.parse(await scored)).toMatchObject({
      type: "entry_state_changed",
      entryId,
      score: 4,
      positions: {},
    });

    const positioned = waitForMessage(subscriber, channel);
    await setCollectionPositions(db, userId, collectionId, [{ entryId, position: 2 }]);
    expect(JSON.parse(await positioned)).toMatchObject({
      type: "entry_state_changed",
      entryId,
      score: 4,
      positions: { [collectionId]: 2 },
    });

    const { events } = await collectSyncChanges(db, userId, { entries: since });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "entry_state_changed",
        entryId,
        score: 4,
        positions: { [collectionId]: 2 },
      })
    );
  });
});

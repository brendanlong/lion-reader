/**
 * Integration tests for the SSE event published by mark-all-read.
 *
 * markRead publishes one entry_state_changed per entry, but mark-all-read is
 * unbounded, so it emits a single lightweight `mark_all_read` signal and each
 * client invalidates its entry lists + counts. Published inside the
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
import { expectNoMessage, waitForMessage } from "../utils/pubsub";
import {
  createAuthContext,
  createTestEntry,
  createTestFeed,
  createTestSubscription,
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

afterAll(async () => {
  await subscriber.quit();
  await db.delete(userEntries);
  await db.delete(entries);
  await db.delete(subscriptions);
  await db.delete(feeds);
  await db.delete(users);
});

beforeEach(async () => {
  await db.delete(userEntries);
  await db.delete(entries);
  await db.delete(subscriptions);
  await db.delete(feeds);
  await db.delete(users);
});

async function seedUnreadEntries(userId: string, count: number): Promise<string[]> {
  const now = new Date();
  const feedId = await createTestFeed({ lastFetchedAt: now, lastEntriesUpdatedAt: now });
  await createTestSubscription(userId, feedId);

  const entryIds: string[] = [];
  for (let i = 0; i < count; i++) {
    entryIds.push(
      await createTestEntry(feedId, { title: `Entry ${i}`, fetchedAt: now, userIds: [userId] })
    );
  }
  return entryIds;
}

describe("entries.markAllRead SSE publishing", () => {
  it("publishes a mark_all_read signal carrying a cursor timestamp and the max marked id", async () => {
    const userId = await createTestUser({ emailPrefix: "mark-all" });
    const entryIds = await seedUnreadEntries(userId, 3);

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
});

/**
 * Integration tests for the entry_state_changed SSE events published by the
 * mark-read and star services.
 *
 * markEntriesRead / updateEntryStarred publish entry_state_changed themselves
 * (not at each API boundary), so every caller — the tRPC mutations, the MCP
 * tools, and the hand-written Google Reader / Wallabag compat routes — notifies
 * a user's other tabs/devices for free (issue #1045). These tests call the
 * services directly (the shared chokepoint) and verify that a real state change
 * publishes, while an idempotent replay (an older changedAt losing the
 * *_changed_at guard) publishes nothing.
 *
 * Uses a real Postgres + Redis via docker-compose.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import Redis from "ioredis";
import { db } from "../../src/server/db";
import {
  users,
  feeds,
  entries,
  subscriptions,
  subscriptionFeeds,
  userEntries,
} from "../../src/server/db/schema";
import { generateUuidv7 } from "../../src/lib/uuidv7";
import * as entriesService from "../../src/server/services/entries";
import { getUserEventsChannel } from "../../src/server/redis/pubsub";

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

async function seedUser(): Promise<string> {
  const userId = generateUuidv7();
  await db.insert(users).values({
    id: userId,
    email: `entry-state-${userId}@test.com`,
    passwordHash: "test-hash",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return userId;
}

async function seedEntry(userId: string): Promise<string> {
  const now = new Date();
  const feedId = generateUuidv7();
  await db.insert(feeds).values({
    id: feedId,
    type: "web",
    url: `https://example.com/${feedId}`,
    title: "Test Feed",
    lastFetchedAt: now,
    lastEntriesUpdatedAt: now,
    createdAt: now,
    updatedAt: now,
  });
  const subscriptionId = generateUuidv7();
  await db.insert(subscriptions).values({
    id: subscriptionId,
    userId,
    feedId,
    subscribedAt: now,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(subscriptionFeeds).values({ subscriptionId, feedId, userId });

  const entryId = generateUuidv7();
  await db.insert(entries).values({
    id: entryId,
    feedId,
    type: "web",
    guid: `guid-${entryId}`,
    title: "Entry",
    contentHash: `hash-${entryId}`,
    fetchedAt: now,
    publishedAt: now,
    lastSeenAt: now,
    createdAt: now,
    updatedAt: now,
  });
  // starred_changed_at is NOT NULL (defaults to now()); seed an explicitly-old
  // value so the positive tests' default changedAt (now) wins the guard.
  await db.insert(userEntries).values({
    userId,
    entryId,
    read: false,
    starred: false,
    starredChangedAt: new Date("2020-01-01T00:00:00Z"),
    updatedAt: now,
  });
  return entryId;
}

// Resolves with the first message on `channel`. Always removes its own listener
// (on match or timeout) so listeners don't accumulate on the shared subscriber.
function waitForMessage(channel: string, timeoutMs = 5000): Promise<string> {
  return new Promise((resolve, reject) => {
    const listener = (ch: string, message: string) => {
      if (ch !== channel) return;
      cleanup();
      resolve(message);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for message"));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      subscriber.off("message", listener);
    };
    subscriber.on("message", listener);
  });
}

// Runs `action`, then waits `quietMs` and asserts no message arrived on `channel`.
async function expectNoMessage(
  channel: string,
  action: () => Promise<unknown>,
  quietMs = 200
): Promise<void> {
  let received = false;
  const listener = (ch: string) => {
    if (ch === channel) received = true;
  };
  subscriber.on("message", listener);
  try {
    await action();
    await new Promise((resolve) => setTimeout(resolve, quietMs));
    expect(received).toBe(false);
  } finally {
    subscriber.off("message", listener);
  }
}

describe("markEntriesRead SSE publishing", () => {
  it("publishes entry_state_changed with absolute counts when an entry changes", async () => {
    const userId = await seedUser();
    const entryId = await seedEntry(userId);

    const channel = getUserEventsChannel(userId);
    await subscriber.subscribe(channel);
    const messagePromise = waitForMessage(channel);

    const { entries: result, counts } = await entriesService.markEntriesRead(
      db,
      userId,
      [{ id: entryId }],
      true
    );
    expect(result[0].read).toBe(true);
    // The service computes counts once and both returns and publishes them.
    expect(counts.all.unread).toBe(0);

    const event = JSON.parse(await messagePromise);
    expect(event.type).toBe("entry_state_changed");
    expect(event.entryId).toBe(entryId);
    expect(event.read).toBe(true);
    expect(event.counts.all.unread).toBe(0);
  });

  it("does not publish when an idempotent replay changes nothing", async () => {
    const userId = await seedUser();
    const entryId = await seedEntry(userId);

    // Establish a recent read_changed_at.
    await entriesService.markEntriesRead(db, userId, [{ id: entryId }], true, {});

    const channel = getUserEventsChannel(userId);
    await subscriber.subscribe(channel);

    // Replaying an older action loses the read_changed_at <= changedAt guard, so
    // no row updates and nothing is published.
    await expectNoMessage(channel, () =>
      entriesService.markEntriesRead(db, userId, [{ id: entryId, changedAt: new Date(0) }], false)
    );
  });
});

describe("updateEntryStarred SSE publishing", () => {
  it("publishes entry_state_changed with absolute counts when starring", async () => {
    const userId = await seedUser();
    const entryId = await seedEntry(userId);

    const channel = getUserEventsChannel(userId);
    await subscriber.subscribe(channel);
    const messagePromise = waitForMessage(channel);

    const { entry, counts } = await entriesService.updateEntryStarred(db, userId, entryId, true);
    expect(entry.starred).toBe(true);
    expect(counts.starred.unread).toBe(1);

    const event = JSON.parse(await messagePromise);
    expect(event.type).toBe("entry_state_changed");
    expect(event.entryId).toBe(entryId);
    expect(event.starred).toBe(true);
    expect(event.counts.starred.unread).toBe(1);
  });

  it("does not publish when an idempotent replay changes nothing", async () => {
    const userId = await seedUser();
    const entryId = await seedEntry(userId);

    // Establish a recent starred_changed_at.
    await entriesService.updateEntryStarred(db, userId, entryId, true, new Date());

    const channel = getUserEventsChannel(userId);
    await subscriber.subscribe(channel);

    // Replaying an older action loses the starred_changed_at <= changedAt guard.
    await expectNoMessage(channel, () =>
      entriesService.updateEntryStarred(db, userId, entryId, false, new Date(0))
    );
  });
});

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
import {
  users,
  feeds,
  entries,
  subscriptions,
  subscriptionFeeds,
  userEntries,
} from "../../src/server/db/schema";
import { generateUuidv7 } from "../../src/lib/uuidv7";
import { createCaller } from "../../src/server/trpc/root";
import { getUserEventsChannel } from "../../src/server/redis/pubsub";
import type { Context } from "../../src/server/trpc/context";

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

function createAuthContext(userId: string): Context {
  const now = new Date();
  return {
    db,
    session: {
      session: {
        id: generateUuidv7(),
        userId,
        tokenHash: "test-hash",
        scopes: null,
        userAgent: null,
        ipAddress: null,
        createdAt: now,
        expiresAt: new Date(Date.now() + 3600000),
        revokedAt: null,
        lastActiveAt: now,
      },
      user: {
        id: userId,
        email: `${userId}@test.com`,
        emailVerifiedAt: null,
        tosAgreedAt: new Date(),
        privacyPolicyAgreedAt: new Date(),
        notEuAgreedAt: new Date(),
        passwordHash: "test-hash",
        inviteId: null,
        showSpam: false,
        lastActiveAt: null,
        groqApiKey: null,
        anthropicApiKey: null,
        summarizationModel: null,
        summarizationMaxWords: null,
        summarizationPrompt: null,
        createdAt: now,
        updatedAt: now,
      },
      hasGroqApiKey: false,
      hasAnthropicApiKey: false,
    },
    apiToken: null,
    authType: "session",
    scopes: [],
    sessionToken: "test-token",
    headers: new Headers(),
  };
}

async function seedUnreadEntries(userId: string, count: number): Promise<string[]> {
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

  const entryIds: string[] = [];
  for (let i = 0; i < count; i++) {
    const entryId = generateUuidv7();
    entryIds.push(entryId);
    await db.insert(entries).values({
      id: entryId,
      feedId,
      type: "web",
      guid: `guid-${entryId}`,
      title: `Entry ${i}`,
      contentHash: `hash-${entryId}`,
      fetchedAt: now,
      publishedAt: now,
      lastSeenAt: now,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(userEntries).values({
      userId,
      entryId,
      read: false,
      starred: false,
      updatedAt: now,
    });
  }
  return entryIds;
}

function waitForMessage(channel: string, timeoutMs = 5000): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for message")), timeoutMs);
    subscriber.on("message", (ch, message) => {
      if (ch === channel) {
        clearTimeout(timer);
        resolve(message);
      }
    });
  });
}

describe("entries.markAllRead SSE publishing", () => {
  it("publishes a mark_all_read signal carrying a cursor timestamp", async () => {
    const userId = generateUuidv7();
    await db.insert(users).values({
      id: userId,
      email: `mark-all-${userId}@test.com`,
      passwordHash: "test-hash",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await seedUnreadEntries(userId, 3);

    const channel = getUserEventsChannel(userId);
    await subscriber.subscribe(channel);
    const messagePromise = waitForMessage(channel);

    const caller = createCaller(createAuthContext(userId));
    const result = await caller.entries.markAllRead({});
    expect(result.count).toBe(3);

    const event = JSON.parse(await messagePromise);
    expect(event.type).toBe("mark_all_read");
    // updatedAt is the mark-all-read timestamp used to advance the entries cursor.
    expect(typeof event.updatedAt).toBe("string");
    expect(Number.isNaN(Date.parse(event.updatedAt))).toBe(false);
  });

  it("publishes no event when nothing was unread", async () => {
    const userId = generateUuidv7();
    await db.insert(users).values({
      id: userId,
      email: `mark-all-none-${userId}@test.com`,
      passwordHash: "test-hash",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const channel = getUserEventsChannel(userId);
    await subscriber.subscribe(channel);
    let received = false;
    subscriber.on("message", (ch) => {
      if (ch === channel) received = true;
    });

    const caller = createCaller(createAuthContext(userId));
    const result = await caller.entries.markAllRead({});
    expect(result.count).toBe(0);

    // Give any (erroneous) publish a chance to arrive.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(received).toBe(false);
  });
});

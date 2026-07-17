/**
 * Integration tests for the "meaningful change vs row touched" rule on
 * subscriptions (issue #1160, generalizing issue #1118 from entries).
 *
 * `subscriptions.update` and `subscriptions.setTags` must bump
 * `subscriptions.updated_at` (which drives the subscription delta-sync cursor
 * — sync.events tracks MAX(subscriptions.updated_at)) and publish the
 * `subscription_updated` SSE event ONLY when a user-visible field actually
 * changes. A re-save with identical customTitle / fetchFullContent, or a
 * re-apply of the identical tag set (the settings-dialog "always PUT the full
 * form" pattern), must do neither. Genuine changes behave exactly as before.
 *
 * Uses a real Postgres + Redis via docker-compose.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import Redis from "ioredis";
import { eq } from "drizzle-orm";
import { db } from "../../src/server/db";
import {
  users,
  feeds,
  subscriptions,
  subscriptionTags,
  tags,
  entries,
  userEntries,
} from "../../src/server/db/schema";
import { generateUuidv7 } from "../../src/lib/uuidv7";
import { createCaller } from "../../src/server/trpc/root";
import type { Context } from "../../src/server/trpc/context";
import { getUserEventsChannel } from "../../src/server/redis/pubsub";

let subscriber: Redis;

beforeAll(() => {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    throw new Error("REDIS_URL must be set for integration tests");
  }
  subscriber = new Redis(redisUrl);
});

async function cleanTables() {
  await db.delete(userEntries);
  await db.delete(entries);
  await db.delete(subscriptionTags);
  await db.delete(tags);
  await db.delete(subscriptions);
  await db.delete(feeds);
  await db.delete(users);
}

afterAll(async () => {
  await subscriber.quit();
  await cleanTables();
});

beforeEach(async () => {
  await cleanTables();
});

// ============================================================================
// Test Helpers
// ============================================================================

async function createTestUser(): Promise<string> {
  const userId = generateUuidv7();
  await db.insert(users).values({
    id: userId,
    email: `sub-update-${userId}@test.com`,
    passwordHash: "test-hash",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return userId;
}

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
        cerebrasApiKey: null,
        summarizationModel: null,
        summarizationMaxWords: null,
        summarizationPrompt: null,
        narrationModel: null,
        savedUnreadCount: 0,
        starredUnreadCount: 0,
        createdAt: now,
        updatedAt: now,
      },
      hasGroqApiKey: false,
      hasAnthropicApiKey: false,
      hasCerebrasApiKey: false,
    },
    apiToken: null,
    authType: "session",
    scopes: [],
    sessionToken: "test-token",
    headers: new Headers(),
  };
}

/**
 * Seeds a feed + active subscription; returns the subscription ID.
 */
async function createTestSubscription(
  userId: string,
  options: { customTitle?: string | null; fetchFullContent?: boolean } = {}
): Promise<string> {
  const now = new Date();
  const feedId = generateUuidv7();
  await db.insert(feeds).values({
    id: feedId,
    type: "web",
    url: `https://example.com/${feedId}`,
    title: "Test Feed",
    createdAt: now,
    updatedAt: now,
  });
  const subscriptionId = generateUuidv7();
  await db.insert(subscriptions).values({
    id: subscriptionId,
    userId,
    feedId,
    customTitle: options.customTitle ?? null,
    fetchFullContent: options.fetchFullContent ?? false,
    subscribedAt: now,
    createdAt: now,
    updatedAt: now,
  });
  return subscriptionId;
}

async function createTestTag(userId: string, name: string): Promise<string> {
  const tagId = generateUuidv7();
  await db.insert(tags).values({
    id: tagId,
    userId,
    name,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return tagId;
}

async function getSubscriptionUpdatedAt(subscriptionId: string): Promise<Date> {
  const [row] = await db
    .select({ updatedAt: subscriptions.updatedAt })
    .from(subscriptions)
    .where(eq(subscriptions.id, subscriptionId));
  return row.updatedAt;
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

// ============================================================================
// Tests
// ============================================================================

describe("subscriptions.update meaningful-change gating (issue #1160)", () => {
  it("publishes subscription_updated and advances updated_at on a real title change", async () => {
    const userId = await createTestUser();
    const subscriptionId = await createTestSubscription(userId, { customTitle: "Old Title" });
    const caller = createCaller(createAuthContext(userId));
    const before = await getSubscriptionUpdatedAt(subscriptionId);

    const channel = getUserEventsChannel(userId);
    await subscriber.subscribe(channel);
    const messagePromise = waitForMessage(channel);

    const result = await caller.subscriptions.update({
      id: subscriptionId,
      customTitle: "New Title",
    });
    expect(result.title).toBe("New Title");

    const event = JSON.parse(await messagePromise);
    expect(event.type).toBe("subscription_updated");
    expect(event.subscriptionId).toBe(subscriptionId);

    const after = await getSubscriptionUpdatedAt(subscriptionId);
    expect(after.getTime()).toBeGreaterThan(before.getTime());
  });

  it("does not publish or advance updated_at when re-saving identical settings", async () => {
    const userId = await createTestUser();
    const subscriptionId = await createTestSubscription(userId, {
      customTitle: "Same Title",
      fetchFullContent: true,
    });
    const caller = createCaller(createAuthContext(userId));
    const before = await getSubscriptionUpdatedAt(subscriptionId);

    const channel = getUserEventsChannel(userId);
    await subscriber.subscribe(channel);

    await expectNoMessage(channel, async () => {
      // The full-form re-save pattern: every field sent, none changed.
      const result = await caller.subscriptions.update({
        id: subscriptionId,
        customTitle: "Same Title",
        fetchFullContent: true,
      });
      // The response still reflects current state, exactly as before.
      expect(result.title).toBe("Same Title");
      expect(result.fetchFullContent).toBe(true);
    });

    const after = await getSubscriptionUpdatedAt(subscriptionId);
    expect(after).toEqual(before);
  });

  it("treats a NULL custom title re-save as a no-op (IS DISTINCT FROM semantics)", async () => {
    const userId = await createTestUser();
    const subscriptionId = await createTestSubscription(userId, { customTitle: null });
    const caller = createCaller(createAuthContext(userId));
    const before = await getSubscriptionUpdatedAt(subscriptionId);

    const channel = getUserEventsChannel(userId);
    await subscriber.subscribe(channel);

    await expectNoMessage(channel, () =>
      caller.subscriptions.update({ id: subscriptionId, customTitle: null })
    );

    const after = await getSubscriptionUpdatedAt(subscriptionId);
    expect(after).toEqual(before);
  });

  it("does not publish or advance updated_at when no fields are provided", async () => {
    const userId = await createTestUser();
    const subscriptionId = await createTestSubscription(userId);
    const caller = createCaller(createAuthContext(userId));
    const before = await getSubscriptionUpdatedAt(subscriptionId);

    const channel = getUserEventsChannel(userId);
    await subscriber.subscribe(channel);

    await expectNoMessage(channel, () => caller.subscriptions.update({ id: subscriptionId }));

    const after = await getSubscriptionUpdatedAt(subscriptionId);
    expect(after).toEqual(before);
  });

  it("publishes when only fetchFullContent flips alongside an identical title", async () => {
    const userId = await createTestUser();
    const subscriptionId = await createTestSubscription(userId, {
      customTitle: "Same Title",
      fetchFullContent: false,
    });
    const caller = createCaller(createAuthContext(userId));
    const before = await getSubscriptionUpdatedAt(subscriptionId);

    const channel = getUserEventsChannel(userId);
    await subscriber.subscribe(channel);
    const messagePromise = waitForMessage(channel);

    const result = await caller.subscriptions.update({
      id: subscriptionId,
      customTitle: "Same Title",
      fetchFullContent: true,
    });
    expect(result.fetchFullContent).toBe(true);

    const event = JSON.parse(await messagePromise);
    expect(event.type).toBe("subscription_updated");

    const after = await getSubscriptionUpdatedAt(subscriptionId);
    expect(after.getTime()).toBeGreaterThan(before.getTime());
  });
});

describe("subscriptions.setTags meaningful-change gating (issue #1160)", () => {
  it("publishes and advances updated_at when the tag set actually changes", async () => {
    const userId = await createTestUser();
    const subscriptionId = await createTestSubscription(userId);
    const tagId = await createTestTag(userId, "Tech");
    const caller = createCaller(createAuthContext(userId));
    const before = await getSubscriptionUpdatedAt(subscriptionId);

    const channel = getUserEventsChannel(userId);
    await subscriber.subscribe(channel);
    const messagePromise = waitForMessage(channel);

    await caller.subscriptions.setTags({ id: subscriptionId, tagIds: [tagId] });

    const event = JSON.parse(await messagePromise);
    expect(event.type).toBe("subscription_updated");
    expect(event.tags).toEqual([{ id: tagId, name: "Tech", color: null }]);

    const after = await getSubscriptionUpdatedAt(subscriptionId);
    expect(after.getTime()).toBeGreaterThan(before.getTime());
  });

  it("does not publish or advance updated_at when re-applying the identical tag set", async () => {
    const userId = await createTestUser();
    const subscriptionId = await createTestSubscription(userId);
    const tagA = await createTestTag(userId, "Tech");
    const tagB = await createTestTag(userId, "News");
    const caller = createCaller(createAuthContext(userId));

    await caller.subscriptions.setTags({ id: subscriptionId, tagIds: [tagA, tagB] });
    const before = await getSubscriptionUpdatedAt(subscriptionId);

    const channel = getUserEventsChannel(userId);
    await subscriber.subscribe(channel);

    // Same set, different order — still identical.
    await expectNoMessage(channel, () =>
      caller.subscriptions.setTags({ id: subscriptionId, tagIds: [tagB, tagA] })
    );

    const after = await getSubscriptionUpdatedAt(subscriptionId);
    expect(after).toEqual(before);

    // The associations are intact.
    const rows = await db
      .select({ tagId: subscriptionTags.tagId })
      .from(subscriptionTags)
      .where(eq(subscriptionTags.subscriptionId, subscriptionId));
    expect(new Set(rows.map((r) => r.tagId))).toEqual(new Set([tagA, tagB]));
  });

  it("publishes when the tag set partially overlaps the previous one", async () => {
    const userId = await createTestUser();
    const subscriptionId = await createTestSubscription(userId);
    const tagA = await createTestTag(userId, "Tech");
    const tagB = await createTestTag(userId, "News");
    const caller = createCaller(createAuthContext(userId));

    await caller.subscriptions.setTags({ id: subscriptionId, tagIds: [tagA] });
    const before = await getSubscriptionUpdatedAt(subscriptionId);

    const channel = getUserEventsChannel(userId);
    await subscriber.subscribe(channel);
    const messagePromise = waitForMessage(channel);

    await caller.subscriptions.setTags({ id: subscriptionId, tagIds: [tagA, tagB] });

    const event = JSON.parse(await messagePromise);
    expect(event.type).toBe("subscription_updated");

    const after = await getSubscriptionUpdatedAt(subscriptionId);
    expect(after.getTime()).toBeGreaterThan(before.getTime());
  });

  it("publishes with empty tags when clearing a tagged subscription", async () => {
    const userId = await createTestUser();
    const subscriptionId = await createTestSubscription(userId);
    const tagId = await createTestTag(userId, "Tech");
    const caller = createCaller(createAuthContext(userId));

    await caller.subscriptions.setTags({ id: subscriptionId, tagIds: [tagId] });
    const before = await getSubscriptionUpdatedAt(subscriptionId);

    const channel = getUserEventsChannel(userId);
    await subscriber.subscribe(channel);
    const messagePromise = waitForMessage(channel);

    await caller.subscriptions.setTags({ id: subscriptionId, tagIds: [] });

    const event = JSON.parse(await messagePromise);
    expect(event.type).toBe("subscription_updated");
    expect(event.tags).toEqual([]);

    const after = await getSubscriptionUpdatedAt(subscriptionId);
    expect(after.getTime()).toBeGreaterThan(before.getTime());
  });

  it("does not publish or advance updated_at when clearing an already-untagged subscription", async () => {
    const userId = await createTestUser();
    const subscriptionId = await createTestSubscription(userId);
    const caller = createCaller(createAuthContext(userId));
    const before = await getSubscriptionUpdatedAt(subscriptionId);

    const channel = getUserEventsChannel(userId);
    await subscriber.subscribe(channel);

    await expectNoMessage(channel, () =>
      caller.subscriptions.setTags({ id: subscriptionId, tagIds: [] })
    );

    const after = await getSubscriptionUpdatedAt(subscriptionId);
    expect(after).toEqual(before);
  });
});

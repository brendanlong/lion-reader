/**
 * Integration tests for the Feed Stats API.
 *
 * Verifies that feedStats.list returns correct per-feed entry statistics
 * (totalEntryCount, entriesPerWeek). These are computed via a LEFT JOIN LATERAL
 * that aggregates the entries table once per feed (#830); this test locks in the
 * expected values so the aggregation stays correct.
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { db } from "../../src/server/db";
import { users, feeds, entries, subscriptions, userEntries } from "../../src/server/db/schema";
import { generateUuidv7 } from "../../src/lib/uuidv7";
import { createCaller } from "../../src/server/trpc/root";
import type { Context } from "../../src/server/trpc/context";

// ============================================================================
// Test Helpers
// ============================================================================

async function createTestUser(emailPrefix = "feedstats"): Promise<string> {
  const userId = generateUuidv7();
  await db.insert(users).values({
    id: userId,
    email: `${emailPrefix}-${userId}@test.com`,
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
        summarizationModel: null,
        summarizationMaxWords: null,
        summarizationPrompt: null,
        savedUnreadCount: 0,
        starredUnreadCount: 0,
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

async function createTestFeed(title: string): Promise<string> {
  const feedId = generateUuidv7();
  await db.insert(feeds).values({
    id: feedId,
    type: "web",
    url: `https://example.com/${feedId}.xml`,
    title,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return feedId;
}

async function createTestSubscription(userId: string, feedId: string): Promise<string> {
  const subscriptionId = generateUuidv7();
  await db.insert(subscriptions).values({
    id: subscriptionId,
    userId,
    feedId,
    subscribedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return subscriptionId;
}

async function createTestEntry(feedId: string, fetchedAt: Date): Promise<void> {
  const entryId = generateUuidv7();
  await db.insert(entries).values({
    id: entryId,
    feedId,
    type: "web",
    guid: `guid-${entryId}`,
    title: `Entry ${entryId}`,
    contentHash: `hash-${entryId}`,
    fetchedAt,
    lastSeenAt: fetchedAt,
    createdAt: fetchedAt,
    updatedAt: fetchedAt,
  });
}

const DAY_MS = 24 * 60 * 60 * 1000;

// ============================================================================
// Tests
// ============================================================================

describe("Feed Stats API", () => {
  beforeEach(async () => {
    await db.delete(userEntries);
    await db.delete(entries);
    await db.delete(subscriptions);
    await db.delete(feeds);
    await db.delete(users);
  });

  afterAll(async () => {
    await db.delete(userEntries);
    await db.delete(entries);
    await db.delete(subscriptions);
    await db.delete(feeds);
    await db.delete(users);
  });

  it("reports totalEntryCount and entriesPerWeek for a feed with history", async () => {
    const userId = await createTestUser();
    const feedId = await createTestFeed("Feed With History");
    const subscriptionId = await createTestSubscription(userId, feedId);

    // Oldest entry 14 days ago, 4 entries total => ~2 entries/week.
    const now = Date.now();
    await createTestEntry(feedId, new Date(now - 14 * DAY_MS));
    await createTestEntry(feedId, new Date(now - 10 * DAY_MS));
    await createTestEntry(feedId, new Date(now - 5 * DAY_MS));
    await createTestEntry(feedId, new Date(now - 1 * DAY_MS));

    const caller = createCaller(createAuthContext(userId));
    const result = await caller.feedStats.list();

    expect(result.items).toHaveLength(1);
    const stats = result.items[0];
    expect(stats.subscriptionId).toBe(subscriptionId);
    expect(stats.totalEntryCount).toBe(4);
    // 4 entries over ~2 weeks => ~2/week (slightly under since NOW() > 14d ago).
    expect(stats.entriesPerWeek).not.toBeNull();
    expect(stats.entriesPerWeek!).toBeGreaterThan(1.9);
    expect(stats.entriesPerWeek!).toBeLessThanOrEqual(2);
  });

  it("returns null entriesPerWeek when the oldest entry is under a week old", async () => {
    const userId = await createTestUser();
    const feedId = await createTestFeed("Fresh Feed");
    await createTestSubscription(userId, feedId);

    const now = Date.now();
    await createTestEntry(feedId, new Date(now - 2 * DAY_MS));
    await createTestEntry(feedId, new Date(now - 1 * DAY_MS));

    const caller = createCaller(createAuthContext(userId));
    const result = await caller.feedStats.list();

    expect(result.items).toHaveLength(1);
    expect(result.items[0].totalEntryCount).toBe(2);
    expect(result.items[0].entriesPerWeek).toBeNull();
  });

  it("reports zero total and null entriesPerWeek for a feed with no entries", async () => {
    const userId = await createTestUser();
    const feedId = await createTestFeed("Empty Feed");
    await createTestSubscription(userId, feedId);

    const caller = createCaller(createAuthContext(userId));
    const result = await caller.feedStats.list();

    expect(result.items).toHaveLength(1);
    expect(result.items[0].totalEntryCount).toBe(0);
    expect(result.items[0].entriesPerWeek).toBeNull();
  });

  it("computes stats independently per feed across multiple subscriptions", async () => {
    const userId = await createTestUser();
    const feedA = await createTestFeed("AAA Feed");
    const feedB = await createTestFeed("BBB Feed");
    await createTestSubscription(userId, feedA);
    await createTestSubscription(userId, feedB);

    const now = Date.now();
    // Feed A: 3 entries
    await createTestEntry(feedA, new Date(now - 20 * DAY_MS));
    await createTestEntry(feedA, new Date(now - 10 * DAY_MS));
    await createTestEntry(feedA, new Date(now - 2 * DAY_MS));
    // Feed B: 1 entry
    await createTestEntry(feedB, new Date(now - 3 * DAY_MS));

    const caller = createCaller(createAuthContext(userId));
    const result = await caller.feedStats.list();

    // Ordered by title ASC: "AAA Feed" then "BBB Feed".
    expect(result.items).toHaveLength(2);
    expect(result.items[0].title).toBe("AAA Feed");
    expect(result.items[0].totalEntryCount).toBe(3);
    expect(result.items[1].title).toBe("BBB Feed");
    expect(result.items[1].totalEntryCount).toBe(1);
  });
});

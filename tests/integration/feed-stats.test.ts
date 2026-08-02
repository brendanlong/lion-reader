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
import { createCaller } from "../../src/server/trpc/root";
import {
  createAuthContext,
  createTestEntry,
  createTestFeed,
  createTestSubscription,
  createTestUser,
} from "./helpers";

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
    const userId = await createTestUser({ emailPrefix: "feedstats" });
    const feedId = await createTestFeed({ title: "Feed With History" });
    const subscriptionId = await createTestSubscription(userId, feedId);

    // Oldest entry 14 days ago, 4 entries total => ~2 entries/week.
    const now = Date.now();
    await createTestEntry(feedId, { fetchedAt: new Date(now - 14 * DAY_MS) });
    await createTestEntry(feedId, { fetchedAt: new Date(now - 10 * DAY_MS) });
    await createTestEntry(feedId, { fetchedAt: new Date(now - 5 * DAY_MS) });
    await createTestEntry(feedId, { fetchedAt: new Date(now - 1 * DAY_MS) });

    const caller = createCaller(await createAuthContext(userId));
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
    const userId = await createTestUser({ emailPrefix: "feedstats" });
    const feedId = await createTestFeed({ title: "Fresh Feed" });
    await createTestSubscription(userId, feedId);

    const now = Date.now();
    await createTestEntry(feedId, { fetchedAt: new Date(now - 2 * DAY_MS) });
    await createTestEntry(feedId, { fetchedAt: new Date(now - 1 * DAY_MS) });

    const caller = createCaller(await createAuthContext(userId));
    const result = await caller.feedStats.list();

    expect(result.items).toHaveLength(1);
    expect(result.items[0].totalEntryCount).toBe(2);
    expect(result.items[0].entriesPerWeek).toBeNull();
  });

  it("reports zero total and null entriesPerWeek for a feed with no entries", async () => {
    const userId = await createTestUser({ emailPrefix: "feedstats" });
    const feedId = await createTestFeed({ title: "Empty Feed" });
    await createTestSubscription(userId, feedId);

    const caller = createCaller(await createAuthContext(userId));
    const result = await caller.feedStats.list();

    expect(result.items).toHaveLength(1);
    expect(result.items[0].totalEntryCount).toBe(0);
    expect(result.items[0].entriesPerWeek).toBeNull();
  });

  it("computes stats independently per feed across multiple subscriptions", async () => {
    const userId = await createTestUser({ emailPrefix: "feedstats" });
    const feedA = await createTestFeed({ title: "AAA Feed" });
    const feedB = await createTestFeed({ title: "BBB Feed" });
    await createTestSubscription(userId, feedA);
    await createTestSubscription(userId, feedB);

    const now = Date.now();
    // Feed A: 3 entries
    await createTestEntry(feedA, { fetchedAt: new Date(now - 20 * DAY_MS) });
    await createTestEntry(feedA, { fetchedAt: new Date(now - 10 * DAY_MS) });
    await createTestEntry(feedA, { fetchedAt: new Date(now - 2 * DAY_MS) });
    // Feed B: 1 entry
    await createTestEntry(feedB, { fetchedAt: new Date(now - 3 * DAY_MS) });

    const caller = createCaller(await createAuthContext(userId));
    const result = await caller.feedStats.list();

    // Ordered by title ASC: "AAA Feed" then "BBB Feed".
    expect(result.items).toHaveLength(2);
    expect(result.items[0].title).toBe("AAA Feed");
    expect(result.items[0].totalEntryCount).toBe(3);
    expect(result.items[1].title).toBe("BBB Feed");
    expect(result.items[1].totalEntryCount).toBe(1);
  });
});

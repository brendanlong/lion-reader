/**
 * Integration tests for the Broken Feeds API.
 *
 * `brokenFeeds.retryFetch` is the only endpoint that mutates, and its ownership
 * check is what keeps one user from resetting another user's feed. These tests
 * cover that check's outcome on both sides: a subscribed feed is rescheduled,
 * and anything else is a NOT_FOUND client error rather than a 500.
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { TRPCError } from "@trpc/server";
import { getHTTPStatusCodeFromError } from "@trpc/server/http";
import { eq } from "drizzle-orm";
import { db } from "../../src/server/db";
import { users, feeds, entries, subscriptions, userEntries } from "../../src/server/db/schema";
import { generateUuidv7 } from "../../src/lib/uuidv7";
import { createCaller } from "../../src/server/trpc/root";
import {
  createAuthContext,
  createTestFeed,
  createTestSubscription,
  createTestUser,
} from "./helpers";

async function clean(): Promise<void> {
  await db.delete(userEntries);
  await db.delete(entries);
  await db.delete(subscriptions);
  await db.delete(feeds);
  await db.delete(users);
}

describe("Broken Feeds API", () => {
  beforeEach(clean);
  afterAll(clean);

  it("lists and retries a broken feed the user is subscribed to", async () => {
    const userId = await createTestUser({ emailPrefix: "brokenfeeds" });
    const feedId = await createTestFeed({
      title: "Failing Feed",
      consecutiveFailures: 3,
      lastError: "500 Server Error",
      nextFetchAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    await createTestSubscription(userId, feedId);

    const caller = createCaller(await createAuthContext(userId));

    const listed = await caller.brokenFeeds.list();
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0].feedId).toBe(feedId);
    expect(listed.items[0].consecutiveFailures).toBe(3);

    const result = await caller.brokenFeeds.retryFetch({ feedId });
    expect(result.success).toBe(true);

    // The failure counter is cleared and a fetch is due immediately.
    const [feed] = await db.select().from(feeds).where(eq(feeds.id, feedId));
    expect(feed.consecutiveFailures).toBe(0);
    expect(feed.lastError).toBeNull();
    expect(feed.nextFetchAt!.getTime()).toBeLessThanOrEqual(Date.now());
  });

  // The ownership check must produce a real 404, not an unhandled Error that
  // tRPC would surface as a 500 (and report to Sentry as a server bug).
  it("rejects retrying a feed the user is not subscribed to with a 404", async () => {
    const userId = await createTestUser({ emailPrefix: "brokenfeeds-unsub" });
    const otherUserId = await createTestUser({ emailPrefix: "brokenfeeds-other" });
    const feedId = await createTestFeed({ consecutiveFailures: 2 });
    // Only the *other* user is subscribed.
    await createTestSubscription(otherUserId, feedId);

    const caller = createCaller(await createAuthContext(userId));

    let thrown: unknown;
    try {
      await caller.brokenFeeds.retryFetch({ feedId });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(TRPCError);
    expect(getHTTPStatusCodeFromError(thrown as TRPCError)).toBe(404);
    expect((thrown as TRPCError).cause).toMatchObject({ code: "FEED_NOT_FOUND" });

    // The other user's feed was left untouched.
    const [feed] = await db.select().from(feeds).where(eq(feeds.id, feedId));
    expect(feed.consecutiveFailures).toBe(2);
  });

  it("rejects retrying a feed that does not exist with a 404", async () => {
    const userId = await createTestUser({ emailPrefix: "brokenfeeds-missing" });
    const caller = createCaller(await createAuthContext(userId));

    let thrown: unknown;
    try {
      await caller.brokenFeeds.retryFetch({ feedId: generateUuidv7() });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(TRPCError);
    expect(getHTTPStatusCodeFromError(thrown as TRPCError)).toBe(404);
  });
});

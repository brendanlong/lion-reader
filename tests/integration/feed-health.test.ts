/**
 * Integration tests for feed fetch health monitoring.
 *
 * Verifies the health snapshot query against a real database and the status the
 * monitor_feed_health job handler reports. The pure evaluation rule and ping
 * body/URL building are unit-tested in tests/unit/feed-health.test.ts.
 *
 * Healthchecks.io pings are no-ops here: FEED_HEALTH_HEARTBEAT_URL is not set in
 * the test environment.
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { db } from "../../src/server/db";
import { jobs, feeds, subscriptions, users } from "../../src/server/db/schema";
import { getFeedFetchHealthSnapshot } from "../../src/server/feed/health";
import { handleMonitorFeedHealth } from "../../src/server/jobs/handlers";
import { createTestFeed, createTestSubscription, createTestUser } from "./helpers";

async function cleanup() {
  await db.delete(jobs);
  await db.delete(subscriptions);
  await db.delete(feeds);
  await db.delete(users);
}

async function createSubscribedFeed(
  userId: string,
  options: {
    lastFetchedAt?: Date | null;
    lastError?: string | null;
    consecutiveFailures?: number;
    unsubscribed?: boolean;
  } = {}
): Promise<string> {
  const feedId = await createTestFeed({
    lastFetchedAt: options.lastFetchedAt ?? null,
    lastError: options.lastError ?? null,
    consecutiveFailures: options.consecutiveFailures ?? 0,
  });
  await createTestSubscription(userId, feedId, {
    unsubscribedAt: options.unsubscribed ? new Date() : null,
  });
  return feedId;
}

function minutesAgo(minutes: number): Date {
  return new Date(Date.now() - minutes * 60 * 1000);
}

describe("getFeedFetchHealthSnapshot", () => {
  beforeEach(cleanup);
  afterAll(cleanup);

  it("returns zero counts with no feeds", async () => {
    const snapshot = await getFeedFetchHealthSnapshot();
    expect(snapshot.pollableFeedCount).toBe(0);
    expect(snapshot.lastSuccessfulFetchAt).toBeNull();
    expect(snapshot.failingFeedCount).toBe(0);
    expect(snapshot.sampleError).toBeNull();
  });

  it("reports the newest successful fetch among error-free feeds", async () => {
    const userId = await createTestUser({ emailPrefix: "feed-health" });
    await createSubscribedFeed(userId, { lastFetchedAt: minutesAgo(90) });
    await createSubscribedFeed(userId, { lastFetchedAt: minutesAgo(10) });
    // Failing feed fetched most recently: must NOT count as a success
    await createSubscribedFeed(userId, {
      lastFetchedAt: minutesAgo(1),
      lastError: "Unknown feed format",
      consecutiveFailures: 3,
    });

    const snapshot = await getFeedFetchHealthSnapshot();
    expect(snapshot.pollableFeedCount).toBe(3);
    expect(snapshot.lastSuccessfulFetchAt!.getTime()).toBeCloseTo(minutesAgo(10).getTime(), -4);
    expect(snapshot.failingFeedCount).toBe(1);
    expect(snapshot.sampleError).toBe("Unknown feed format");
  });

  it("ignores feeds without active subscribers", async () => {
    const userId = await createTestUser({ emailPrefix: "feed-health" });
    await createSubscribedFeed(userId, {
      lastFetchedAt: minutesAgo(5),
      unsubscribed: true,
    });

    const snapshot = await getFeedFetchHealthSnapshot();
    expect(snapshot.pollableFeedCount).toBe(0);
    expect(snapshot.lastSuccessfulFetchAt).toBeNull();
  });
});

describe("handleMonitorFeedHealth", () => {
  // Alert delivery/cadence is owned by the external healthchecks.io monitor, so
  // the handler keeps no state; these assert the status it reports each run.
  // FEED_HEALTH_HEARTBEAT_URL is unset in .env.test, so pinging is a no-op.
  beforeEach(cleanup);
  afterAll(cleanup);

  it("reports healthy and schedules the next run ~15 minutes out", async () => {
    const userId = await createTestUser({ emailPrefix: "feed-health" });
    await createSubscribedFeed(userId, { lastFetchedAt: minutesAgo(5) });

    const result = await handleMonitorFeedHealth({});

    expect(result.success).toBe(true);
    expect(result.nextRunAt.getTime()).toBeGreaterThan(Date.now() + 14 * 60 * 1000);
    expect(result.metadata?.status).toBe("healthy");
  });

  it("reports unhealthy when the newest success is older than the threshold", async () => {
    const userId = await createTestUser({ emailPrefix: "feed-health" });
    // All feeds failing, newest success well beyond the 120-minute default
    await createSubscribedFeed(userId, {
      lastFetchedAt: minutesAgo(10),
      lastError: "Unknown feed format",
      consecutiveFailures: 5,
    });

    const result = await handleMonitorFeedHealth({});

    expect(result.success).toBe(true);
    expect(result.metadata?.status).toBe("unhealthy");
    expect(result.metadata?.failingFeedCount).toBe(1);
  });

  it("treats an instance with no pollable feeds as healthy", async () => {
    const result = await handleMonitorFeedHealth({});
    expect(result.metadata?.status).toBe("healthy");
  });
});

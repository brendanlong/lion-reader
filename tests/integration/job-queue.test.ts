/**
 * Integration tests for the Postgres-based job queue.
 *
 * These tests use a real database to verify job queue behavior,
 * including concurrent job claiming with row locking.
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "../../src/server/db";
import { jobs, feeds, subscriptions, users } from "../../src/server/db/schema";
import {
  createJob,
  claimJob,
  finishJob,
  getJobPayload,
  ensureFeedJob,
  updateFeedJobNextRun,
  scheduleFeedRefreshNow,
  claimFeedJob,
  claimSingletonJob,
  seedSingletonJobs,
  SINGLETON_JOB_TYPES,
  STALE_JOB_THRESHOLD_MS,
  type JobType,
} from "../../src/server/jobs/queue";
import { runJobHandler } from "../../src/server/jobs/worker";
import { generateUuidv7 } from "../../src/lib/uuidv7";
import { createTestFeed, createTestSubscription, createTestUser } from "./helpers";

// A valid UUID that doesn't exist in the database
const NON_EXISTENT_JOB_ID = "00000000-0000-7000-8000-000000000000";

// Row readers for asserting on queue state. The queue itself never reads rows
// back like this — it claims and finishes — so these live here rather than in
// src/, where they would be production-dead.
async function getJob(jobId: string) {
  const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);

  return job ?? null;
}

async function listJobs(options: { type?: JobType; limit?: number } = {}) {
  const { type, limit = 100 } = options;

  if (type) {
    return db.select().from(jobs).where(eq(jobs.type, type)).limit(limit);
  }

  return db.select().from(jobs).limit(limit);
}

describe("Job Queue", () => {
  async function cleanup(): Promise<void> {
    await db.delete(jobs);
    await db.delete(subscriptions);
    await db.delete(feeds);
    await db.delete(users);
  }

  beforeEach(cleanup);
  afterAll(cleanup);

  describe("createJob", () => {
    it("creates a job with default values", async () => {
      const job = await createJob({
        type: "fetch_feed",
        payload: { feedId: "test-feed-id" },
      });

      expect(job.id).toBeDefined();
      expect(job.type).toBe("fetch_feed");
      expect(job.consecutiveFailures).toBe(0);
      expect(job.nextRunAt).toBeInstanceOf(Date);
      expect(job.runningSince).toBeNull();
      expect(job.lastRunAt).toBeNull();
      expect(job.lastError).toBeNull();

      const payload = getJobPayload(job, "fetch_feed");
      expect(payload.feedId).toBe("test-feed-id");
    });
  });

  describe("claimJob", () => {
    it("claims a pending job", async () => {
      const created = await createJob({
        type: "fetch_feed",
        payload: { feedId: "test-feed-id" },
      });

      const claimed = await claimJob();

      expect(claimed).not.toBeNull();
      expect(claimed!.id).toBe(created.id);
      expect(claimed!.runningSince).toBeInstanceOf(Date);
    });

    it("returns null when no jobs are available", async () => {
      const claimed = await claimJob();
      expect(claimed).toBeNull();
    });

    it("does not claim jobs scheduled for the future", async () => {
      const futureDate = new Date(Date.now() + 60 * 60 * 1000); // 1 hour from now

      await createJob({
        type: "fetch_feed",
        payload: { feedId: "test-feed-id" },
        nextRunAt: futureDate,
      });

      const claimed = await claimJob();
      expect(claimed).toBeNull();
    });

    it("claims jobs in nextRunAt order (oldest first)", async () => {
      const now = new Date();
      const earlier = new Date(now.getTime() - 60 * 1000); // 1 minute ago

      // Create jobs in reverse order
      const job2 = await createJob({
        type: "fetch_feed",
        payload: { feedId: "feed-2" },
        nextRunAt: now,
      });

      const job1 = await createJob({
        type: "fetch_feed",
        payload: { feedId: "feed-1" },
        nextRunAt: earlier,
      });

      // Should claim the earlier job first
      const claimed1 = await claimJob();
      expect(claimed1!.id).toBe(job1.id);

      // Finish job1 so we can claim job2
      await finishJob(job1.id, {
        success: true,
        nextRunAt: new Date(Date.now() + 60 * 60 * 1000),
      });

      const claimed2 = await claimJob();
      expect(claimed2!.id).toBe(job2.id);
    });

    it("filters jobs by type", async () => {
      await createJob({
        type: "renew_websub",
        payload: {},
      });

      await createJob({
        type: "fetch_feed",
        payload: { feedId: "test-feed-id" },
      });

      // Should only claim fetch_feed jobs
      const claimed = await claimJob({ types: ["fetch_feed"] });
      expect(claimed).not.toBeNull();
      expect(claimed!.type).toBe("fetch_feed");

      // The renew_websub job should still be pending
      const remainingJobs = await listJobs({ type: "renew_websub" });
      expect(remainingJobs).toHaveLength(1);
    });

    it("does not claim already running jobs", async () => {
      const created = await createJob({
        type: "fetch_feed",
        payload: { feedId: "test-feed-id" },
      });

      // Claim the job
      const claimed1 = await claimJob();
      expect(claimed1!.id).toBe(created.id);

      // Try to claim again - should get null (job is still running)
      const claimed2 = await claimJob();
      expect(claimed2).toBeNull();
    });

    it("reclaims stale jobs", async () => {
      const job = await createJob({
        type: "fetch_feed",
        payload: { feedId: "test-feed-id" },
      });

      // Claim the job
      await claimJob();

      const staleTime = new Date(Date.now() - STALE_JOB_THRESHOLD_MS - 1000);
      await db
        .update(jobs)
        .set({ runningSince: staleTime })
        .where(sql`id = ${job.id}`);

      // Should be able to reclaim the stale job
      const reclaimed = await claimJob();
      expect(reclaimed).not.toBeNull();
      expect(reclaimed!.id).toBe(job.id);
    });
  });

  describe("concurrent job claiming", () => {
    it("only one worker gets a job when claiming concurrently", async () => {
      // Create a single job
      await createJob({
        type: "fetch_feed",
        payload: { feedId: "test-feed-id" },
      });

      // Simulate 5 workers trying to claim the job concurrently
      const claimPromises = Array.from({ length: 5 }, () => claimJob());
      const results = await Promise.all(claimPromises);

      // Only one should have gotten the job
      const successfulClaims = results.filter((r) => r !== null);
      expect(successfulClaims).toHaveLength(1);

      // The rest should have gotten null
      const failedClaims = results.filter((r) => r === null);
      expect(failedClaims).toHaveLength(4);
    });

    it("multiple jobs can be claimed by multiple workers", async () => {
      // Create 3 jobs
      await createJob({
        type: "fetch_feed",
        payload: { feedId: "feed-1" },
      });
      await createJob({
        type: "fetch_feed",
        payload: { feedId: "feed-2" },
      });
      await createJob({
        type: "fetch_feed",
        payload: { feedId: "feed-3" },
      });

      // 5 workers try to claim jobs concurrently
      const claimPromises = Array.from({ length: 5 }, () => claimJob());
      const results = await Promise.all(claimPromises);

      // 3 should succeed (one for each job)
      const successfulClaims = results.filter((r) => r !== null);
      expect(successfulClaims).toHaveLength(3);

      // All claimed jobs should have unique IDs
      const claimedIds = successfulClaims.map((r) => r!.id);
      const uniqueIds = new Set(claimedIds);
      expect(uniqueIds.size).toBe(3);
    });
  });

  describe("claimSingletonJob", () => {
    it("claims a seeded singleton job", async () => {
      await seedSingletonJobs();
      const job = await claimSingletonJob("monitor_feed_health");

      expect(job).not.toBeNull();
      expect(job!.type).toBe("monitor_feed_health");
      expect(job!.runningSince).not.toBeNull();
    });

    it("rejects non-singleton job types", async () => {
      await expect(claimSingletonJob("fetch_feed")).rejects.toThrow(
        "fetch_feed is not a singleton job type"
      );
    });

    it("seeds one row per singleton type, even when workers seed concurrently", async () => {
      await createJob({ type: "renew_websub", payload: {}, nextRunAt: new Date(0) });
      await Promise.all(Array.from({ length: 5 }, () => seedSingletonJobs()));

      const rows = await listJobs({ limit: 100 });
      expect(rows.map((r) => r.type).sort()).toEqual([...SINGLETON_JOB_TYPES].sort());
      // An existing row is left alone.
      expect(rows.find((r) => r.type === "renew_websub")!.nextRunAt).toEqual(new Date(0));
    });

    it("returns null when an existing job is not yet due", async () => {
      await createJob({
        type: "renew_websub",
        payload: {},
        nextRunAt: new Date(Date.now() + 60 * 60 * 1000), // 1 hour out
      });

      const job = await claimSingletonJob("renew_websub");
      expect(job).toBeNull();
    });
  });

  describe("finishJob", () => {
    it("finishes a job successfully", async () => {
      await createJob({
        type: "fetch_feed",
        payload: { feedId: "test-feed-id" },
      });

      const claimed = await claimJob();
      const nextRunAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour from now

      const finished = await finishJob(claimed!.id, {
        success: true,
        nextRunAt,
      });

      expect(finished!.runningSince).toBeNull();
      expect(finished!.lastRunAt).toBeInstanceOf(Date);
      expect(finished!.nextRunAt!.getTime()).toBe(nextRunAt.getTime());
      expect(finished!.lastError).toBeNull();
      expect(finished!.consecutiveFailures).toBe(0);
    });

    it("finishes a job with failure", async () => {
      await createJob({
        type: "fetch_feed",
        payload: { feedId: "test-feed-id" },
      });

      const claimed = await claimJob();
      const nextRunAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes from now

      const finished = await finishJob(claimed!.id, {
        success: false,
        nextRunAt,
        error: "Connection timeout",
      });

      expect(finished!.runningSince).toBeNull();
      expect(finished!.lastRunAt).toBeInstanceOf(Date);
      expect(finished!.nextRunAt!.getTime()).toBe(nextRunAt.getTime());
      expect(finished!.lastError).toBe("Connection timeout");
      expect(finished!.consecutiveFailures).toBe(1);
    });

    it("increments consecutiveFailures on repeated failures", async () => {
      const job = await createJob({
        type: "fetch_feed",
        payload: { feedId: "test-feed-id" },
      });

      // First failure
      await claimJob();
      await finishJob(job.id, {
        success: false,
        nextRunAt: new Date(),
        error: "Error 1",
      });

      // Second failure
      await claimJob();
      const finished = await finishJob(job.id, {
        success: false,
        nextRunAt: new Date(),
        error: "Error 2",
      });

      expect(finished!.consecutiveFailures).toBe(2);
      expect(finished!.lastError).toBe("Error 2");
    });

    it("resets consecutiveFailures on success", async () => {
      const job = await createJob({
        type: "fetch_feed",
        payload: { feedId: "test-feed-id" },
      });

      // Fail twice
      await claimJob();
      await finishJob(job.id, {
        success: false,
        nextRunAt: new Date(),
        error: "Error 1",
      });
      await claimJob();
      await finishJob(job.id, {
        success: false,
        nextRunAt: new Date(),
        error: "Error 2",
      });

      // Succeed
      await claimJob();
      const finished = await finishJob(job.id, {
        success: true,
        nextRunAt: new Date(Date.now() + 60 * 60 * 1000),
      });

      expect(finished!.consecutiveFailures).toBe(0);
      expect(finished!.lastError).toBeNull();
    });

    it("deletes a one-time job once its handler returns, even on failure", async () => {
      const job = await createJob({
        type: "process_opml_import",
        payload: { importId: generateUuidv7() },
      });
      const claimed = await claimJob();

      // The import doesn't exist, so the handler reports a failure.
      const result = await runJobHandler(claimed!, "process_opml_import", Date.now());
      expect(result.success).toBe(false);

      expect(await finishJob(job.id, result)).toBeNull();
      expect(await getJob(job.id)).toBeNull();
    });

    it("is a no-op for a job that's already gone", async () => {
      expect(
        await finishJob(NON_EXISTENT_JOB_ID, { success: true, nextRunAt: new Date() })
      ).toBeNull();
    });
  });

  describe("feed job helpers", () => {
    it("ensureFeedJob creates a new job", async () => {
      const feedId = generateUuidv7();
      const job = await ensureFeedJob(feedId);

      expect(job.type).toBe("fetch_feed");
      expect(getJobPayload(job, "fetch_feed").feedId).toBe(feedId);
    });

    it("ensureFeedJob does not create duplicate jobs under concurrency (#952)", async () => {
      const feedId = generateUuidv7();

      // Fire several concurrent ensureFeedJob calls for the same feed. The
      // partial unique index + ON CONFLICT must collapse these to a single row
      // (the old UPDATE-then-INSERT could let several inserts win the race).
      const results = await Promise.all(Array.from({ length: 8 }, () => ensureFeedJob(feedId)));

      const allJobs = await listJobs({ type: "fetch_feed" });
      expect(allJobs).toHaveLength(1);
      // Every caller resolves to the one surviving row.
      for (const job of results) {
        expect(job.id).toBe(allJobs[0].id);
      }
    });

    it("ensureFeedJob keeps an existing non-null next_run_at", async () => {
      const feedId = generateUuidv7();
      const scheduled = new Date(Date.now() + 3 * 60 * 60 * 1000);

      await createJob({ type: "fetch_feed", payload: { feedId }, nextRunAt: scheduled });

      // Re-ensuring should not disturb an already-scheduled next_run_at.
      const job = await ensureFeedJob(feedId);
      expect(job.nextRunAt!.getTime()).toBe(scheduled.getTime());
    });

    it("updateFeedJobNextRun updates the next run time", async () => {
      const feedId = generateUuidv7();
      const originalTime = new Date(Date.now() + 60 * 60 * 1000);

      await createJob({
        type: "fetch_feed",
        payload: { feedId },
        nextRunAt: originalTime,
      });

      const newTime = new Date(Date.now() + 4 * 60 * 60 * 1000);
      const updated = await updateFeedJobNextRun(feedId, newTime);

      expect(updated).not.toBeNull();
      expect(updated!.nextRunAt!.getTime()).toBe(newTime.getTime());
    });

    it("scheduleFeedRefreshNow creates a force-reprocess job set to run now", async () => {
      const feedId = generateUuidv7();
      const job = await scheduleFeedRefreshNow(feedId);

      expect(job.type).toBe("fetch_feed");
      const payload = getJobPayload(job, "fetch_feed");
      expect(payload.feedId).toBe(feedId);
      expect(typeof payload.forceReprocessRequestedAt).toBe("string");
      expect(job.nextRunAt!.getTime()).toBeLessThanOrEqual(Date.now());

      // Single-flight: still exactly one job for the feed.
      expect(await listJobs({ type: "fetch_feed" })).toHaveLength(1);
    });

    it("scheduleFeedRefreshNow pulls an already-scheduled job forward and sets the token", async () => {
      const feedId = generateUuidv7();
      const future = new Date(Date.now() + 3 * 60 * 60 * 1000);
      await createJob({ type: "fetch_feed", payload: { feedId }, nextRunAt: future });

      const job = await scheduleFeedRefreshNow(feedId);

      // Coalesced onto the existing single job, pulled forward, token merged in,
      // feedId preserved.
      expect(await listJobs({ type: "fetch_feed" })).toHaveLength(1);
      expect(job.nextRunAt!.getTime()).toBeLessThanOrEqual(Date.now());
      const payload = getJobPayload(job, "fetch_feed");
      expect(payload.feedId).toBe(feedId);
      expect(typeof payload.forceReprocessRequestedAt).toBe("string");
    });

    it("finishJob consumes the forceReprocess token on a successful run", async () => {
      const feedId = generateUuidv7();
      await scheduleFeedRefreshNow(feedId);
      const claimed = await claimJob();
      const claimedAt = getJobPayload(claimed!, "fetch_feed").forceReprocessRequestedAt;
      expect(typeof claimedAt).toBe("string");

      const cadence = new Date(Date.now() + 60 * 60 * 1000);
      const finished = await finishJob(claimed!.id, {
        success: true,
        nextRunAt: cadence,
        consumeForceReprocess: { claimedAt: claimedAt ?? null },
      });

      // Token consumed, feedId preserved, normal cadence used.
      expect(getJobPayload(finished!, "fetch_feed").forceReprocessRequestedAt).toBeUndefined();
      expect(getJobPayload(finished!, "fetch_feed").feedId).toBe(feedId);
      expect(finished!.nextRunAt!.getTime()).toBe(cadence.getTime());
    });

    it("finishJob keeps a mid-run re-armed token and re-runs now (no lost request)", async () => {
      // Two subscribers race a running forced fetch: sub1 arms + the worker
      // claims; sub2 re-arms with a newer token while the fetch runs. The finish
      // must NOT drop sub2's request — it keeps the token and pulls next_run to
      // now so the fetch re-runs and covers sub2.
      const feedId = generateUuidv7();
      await scheduleFeedRefreshNow(feedId);
      const claimed = await claimJob();
      const claimedAt = getJobPayload(claimed!, "fetch_feed").forceReprocessRequestedAt!;

      // Re-arm with a strictly-later token (simulate sub2 mid-run).
      await db
        .update(jobs)
        .set({
          payload: sql`${jobs.payload} || jsonb_build_object('forceReprocessRequestedAt', ${new Date(Date.now() + 1000).toISOString()}::text)`,
        })
        .where(eq(jobs.id, claimed!.id));

      const finished = await finishJob(claimed!.id, {
        success: true,
        nextRunAt: new Date(Date.now() + 60 * 60 * 1000),
        consumeForceReprocess: { claimedAt: claimedAt ?? null },
      });

      // Token still present (sub2's request survives) and scheduled to run now.
      expect(getJobPayload(finished!, "fetch_feed").forceReprocessRequestedAt).toBeDefined();
      expect(finished!.nextRunAt!.getTime()).toBeLessThanOrEqual(Date.now());
    });

    it("finishJob after an ordinary poll runs now if a request landed mid-run", async () => {
      // A plain poll (no token at claim) finishes while a subscribe arms the job.
      // The finish must honor the pending request: keep it and run now.
      const feedId = generateUuidv7();
      await createJob({ type: "fetch_feed", payload: { feedId }, nextRunAt: new Date() });
      const claimed = await claimJob();
      expect(getJobPayload(claimed!, "fetch_feed").forceReprocessRequestedAt).toBeUndefined();

      // A subscribe arms the job during the run.
      await scheduleFeedRefreshNow(feedId);

      const finished = await finishJob(claimed!.id, {
        success: true,
        nextRunAt: new Date(Date.now() + 60 * 60 * 1000),
        consumeForceReprocess: { claimedAt: null },
      });

      expect(getJobPayload(finished!, "fetch_feed").forceReprocessRequestedAt).toBeDefined();
      expect(finished!.nextRunAt!.getTime()).toBeLessThanOrEqual(Date.now());
    });
  });

  describe("claimFeedJob (data-driven)", () => {
    it("does not claim feed job when no active subscribers", async () => {
      // Create a feed
      const feedId = await createTestFeed();

      // Create a job due to run
      await createJob({
        type: "fetch_feed",
        payload: { feedId },
        nextRunAt: new Date(Date.now() - 1000), // 1 second ago
      });

      // No subscriptions - job should not be claimed
      const claimed = await claimFeedJob();
      expect(claimed).toBeNull();
    });

    it("claims feed job when there are active subscribers", async () => {
      // Create a test user
      const userId = await createTestUser();

      // Create a feed
      const feedId = await createTestFeed();

      // Create an active subscription
      await createTestSubscription(userId, feedId);

      // Create a job due to run
      await createJob({
        type: "fetch_feed",
        payload: { feedId },
        nextRunAt: new Date(Date.now() - 1000), // 1 second ago
      });

      // Has subscriber - job should be claimed
      const claimed = await claimFeedJob();
      expect(claimed).not.toBeNull();
      expect(getJobPayload(claimed!, "fetch_feed").feedId).toBe(feedId);
    });

    it("does not claim feed job when subscriber has unsubscribed", async () => {
      // Create a test user
      const userId = await createTestUser();

      // Create a feed
      const feedId = await createTestFeed();

      // Create an unsubscribed subscription
      await createTestSubscription(userId, feedId, { unsubscribedAt: new Date() });

      // Create a job due to run
      await createJob({
        type: "fetch_feed",
        payload: { feedId },
        nextRunAt: new Date(Date.now() - 1000), // 1 second ago
      });

      // No active subscribers - job should not be claimed
      const claimed = await claimFeedJob();
      expect(claimed).toBeNull();
    });

    it("does not claim feed job scheduled for the future", async () => {
      // Create a test user
      const userId = await createTestUser();

      // Create a feed
      const feedId = await createTestFeed();

      // Create an active subscription
      await createTestSubscription(userId, feedId);

      // Create a job scheduled for the future
      await createJob({
        type: "fetch_feed",
        payload: { feedId },
        nextRunAt: new Date(Date.now() + 60 * 60 * 1000), // 1 hour from now
      });

      // Not due yet - job should not be claimed
      const claimed = await claimFeedJob();
      expect(claimed).toBeNull();
    });
  });
});

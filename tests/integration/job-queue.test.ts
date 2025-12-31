/**
 * Integration tests for the Postgres-based job queue.
 *
 * These tests use a real database to verify job queue behavior,
 * including concurrent job claiming with row locking.
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "../../src/server/db";
import { jobs, feeds, subscriptions, users } from "../../src/server/db/schema";
import {
  createJob,
  claimJob,
  finishJob,
  getJob,
  getJobPayload,
  listJobs,
  createOrEnableFeedJob,
  enableFeedJob,
  syncFeedJobEnabled,
  updateFeedJobNextRun,
} from "../../src/server/jobs";
import { generateUuidv7 } from "../../src/lib/uuidv7";

// A valid UUID that doesn't exist in the database
const NON_EXISTENT_JOB_ID = "00000000-0000-7000-8000-000000000000";

describe("Job Queue", () => {
  // Clean up jobs table before each test
  beforeEach(async () => {
    await db.delete(jobs);
    await db.delete(subscriptions);
    await db.delete(feeds);
    await db.delete(users);
  });

  // Clean up after all tests
  afterAll(async () => {
    await db.delete(jobs);
    await db.delete(subscriptions);
    await db.delete(feeds);
    await db.delete(users);
  });

  describe("createJob", () => {
    it("creates a job with default values", async () => {
      const job = await createJob({
        type: "fetch_feed",
        payload: { feedId: "test-feed-id" },
      });

      expect(job.id).toBeDefined();
      expect(job.type).toBe("fetch_feed");
      expect(job.enabled).toBe(true);
      expect(job.consecutiveFailures).toBe(0);
      expect(job.nextRunAt).toBeInstanceOf(Date);
      expect(job.runningSince).toBeNull();
      expect(job.lastRunAt).toBeNull();
      expect(job.lastError).toBeNull();

      const payload = getJobPayload<"fetch_feed">(job);
      expect(payload.feedId).toBe("test-feed-id");
    });

    it("creates a job with custom nextRunAt", async () => {
      const futureDate = new Date(Date.now() + 60 * 60 * 1000); // 1 hour from now

      const job = await createJob({
        type: "fetch_feed",
        payload: { feedId: "test-feed-id" },
        nextRunAt: futureDate,
      });

      expect(job.nextRunAt!.getTime()).toBe(futureDate.getTime());
    });

    it("creates a disabled job", async () => {
      const job = await createJob({
        type: "fetch_feed",
        payload: { feedId: "test-feed-id" },
        enabled: false,
      });

      expect(job.enabled).toBe(false);
    });

    it("creates a renew_websub job with empty payload", async () => {
      const job = await createJob({
        type: "renew_websub",
        payload: {},
      });

      expect(job.type).toBe("renew_websub");
      const payload = getJobPayload<"renew_websub">(job);
      expect(payload).toEqual({});
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

    it("does not claim disabled jobs", async () => {
      await createJob({
        type: "fetch_feed",
        payload: { feedId: "test-feed-id" },
        enabled: false,
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
      const remainingJobs = await listJobs({ enabled: true, type: "renew_websub" });
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

    it("reclaims stale jobs (running > 5 minutes)", async () => {
      const job = await createJob({
        type: "fetch_feed",
        payload: { feedId: "test-feed-id" },
      });

      // Claim the job
      await claimJob();

      // Manually set running_since to 10 minutes ago
      const staleTime = new Date(Date.now() - 10 * 60 * 1000);
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

      expect(finished.runningSince).toBeNull();
      expect(finished.lastRunAt).toBeInstanceOf(Date);
      expect(finished.nextRunAt!.getTime()).toBe(nextRunAt.getTime());
      expect(finished.lastError).toBeNull();
      expect(finished.consecutiveFailures).toBe(0);
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

      expect(finished.runningSince).toBeNull();
      expect(finished.lastRunAt).toBeInstanceOf(Date);
      expect(finished.nextRunAt!.getTime()).toBe(nextRunAt.getTime());
      expect(finished.lastError).toBe("Connection timeout");
      expect(finished.consecutiveFailures).toBe(1);
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

      expect(finished.consecutiveFailures).toBe(2);
      expect(finished.lastError).toBe("Error 2");
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

      expect(finished.consecutiveFailures).toBe(0);
      expect(finished.lastError).toBeNull();
    });

    it("throws error for non-existent job", async () => {
      await expect(
        finishJob(NON_EXISTENT_JOB_ID, { success: true, nextRunAt: new Date() })
      ).rejects.toThrow(`Job not found: ${NON_EXISTENT_JOB_ID}`);
    });
  });

  describe("getJob", () => {
    it("retrieves a job by ID", async () => {
      const created = await createJob({
        type: "fetch_feed",
        payload: { feedId: "test-feed-id" },
      });

      const retrieved = await getJob(created.id);

      expect(retrieved).not.toBeNull();
      expect(retrieved!.id).toBe(created.id);
      expect(retrieved!.type).toBe("fetch_feed");
    });

    it("returns null for non-existent job", async () => {
      const retrieved = await getJob(NON_EXISTENT_JOB_ID);
      expect(retrieved).toBeNull();
    });
  });

  describe("listJobs", () => {
    it("lists all jobs", async () => {
      await createJob({
        type: "fetch_feed",
        payload: { feedId: "feed-1" },
      });
      await createJob({
        type: "renew_websub",
        payload: {},
      });

      const allJobs = await listJobs();
      expect(allJobs).toHaveLength(2);
    });

    it("filters by enabled", async () => {
      await createJob({
        type: "fetch_feed",
        payload: { feedId: "feed-1" },
        enabled: true,
      });
      await createJob({
        type: "fetch_feed",
        payload: { feedId: "feed-2" },
        enabled: false,
      });

      const enabledJobs = await listJobs({ enabled: true });
      expect(enabledJobs).toHaveLength(1);

      const disabledJobs = await listJobs({ enabled: false });
      expect(disabledJobs).toHaveLength(1);
    });

    it("filters by type", async () => {
      await createJob({
        type: "fetch_feed",
        payload: { feedId: "feed-1" },
      });
      await createJob({
        type: "renew_websub",
        payload: {},
      });

      const fetchJobs = await listJobs({ type: "fetch_feed" });
      expect(fetchJobs).toHaveLength(1);
      expect(fetchJobs[0].type).toBe("fetch_feed");
    });

    it("respects limit", async () => {
      for (let i = 0; i < 10; i++) {
        await createJob({
          type: "fetch_feed",
          payload: { feedId: `feed-${i}` },
        });
      }

      const limitedJobs = await listJobs({ limit: 5 });
      expect(limitedJobs).toHaveLength(5);
    });
  });

  describe("feed job helpers", () => {
    it("createOrEnableFeedJob creates a new job", async () => {
      const feedId = generateUuidv7();
      const job = await createOrEnableFeedJob(feedId);

      expect(job.type).toBe("fetch_feed");
      expect(job.enabled).toBe(true);
      expect(getJobPayload<"fetch_feed">(job).feedId).toBe(feedId);
    });

    it("createOrEnableFeedJob enables existing disabled job", async () => {
      const feedId = generateUuidv7();

      // Create a disabled job
      await createJob({
        type: "fetch_feed",
        payload: { feedId },
        enabled: false,
      });

      // Should enable it, not create a new one
      const job = await createOrEnableFeedJob(feedId);

      expect(job.enabled).toBe(true);

      // Should only be one job
      const allJobs = await listJobs({ type: "fetch_feed" });
      expect(allJobs).toHaveLength(1);
    });

    it("enableFeedJob enables a disabled job", async () => {
      const feedId = generateUuidv7();

      await createJob({
        type: "fetch_feed",
        payload: { feedId },
        enabled: false,
      });

      const job = await enableFeedJob(feedId);

      expect(job).not.toBeNull();
      expect(job!.enabled).toBe(true);
    });

    it("enableFeedJob returns null if job doesn't exist", async () => {
      const feedId = generateUuidv7();
      const job = await enableFeedJob(feedId);
      expect(job).toBeNull();
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
  });

  describe("syncFeedJobEnabled", () => {
    it("disables job when no active subscribers", async () => {
      // Create a test user
      const userId = generateUuidv7();
      await db.insert(users).values({
        id: userId,
        email: "test@example.com",
        passwordHash: "hash",
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      // Create a feed
      const feedId = generateUuidv7();
      await db.insert(feeds).values({
        id: feedId,
        type: "rss",
        url: "https://example.com/feed.xml",
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      // Create a job
      await createJob({
        type: "fetch_feed",
        payload: { feedId },
        enabled: true,
      });

      // No subscriptions - job should be disabled
      const result = await syncFeedJobEnabled(feedId);

      expect(result).not.toBeNull();
      expect(result!.enabled).toBe(false);
    });

    it("keeps job enabled when there are active subscribers", async () => {
      // Create a test user
      const userId = generateUuidv7();
      await db.insert(users).values({
        id: userId,
        email: "test@example.com",
        passwordHash: "hash",
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      // Create a feed
      const feedId = generateUuidv7();
      await db.insert(feeds).values({
        id: feedId,
        type: "rss",
        url: "https://example.com/feed.xml",
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      // Create an active subscription
      await db.insert(subscriptions).values({
        id: generateUuidv7(),
        userId,
        feedId,
        subscribedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      // Create a job
      await createJob({
        type: "fetch_feed",
        payload: { feedId },
        enabled: true,
      });

      // Has subscriber - job should stay enabled
      const result = await syncFeedJobEnabled(feedId);

      expect(result).not.toBeNull();
      expect(result!.enabled).toBe(true);
    });

    it("keeps job disabled when subscriber has unsubscribed", async () => {
      // Create a test user
      const userId = generateUuidv7();
      await db.insert(users).values({
        id: userId,
        email: "test@example.com",
        passwordHash: "hash",
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      // Create a feed
      const feedId = generateUuidv7();
      await db.insert(feeds).values({
        id: feedId,
        type: "rss",
        url: "https://example.com/feed.xml",
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      // Create an unsubscribed subscription
      await db.insert(subscriptions).values({
        id: generateUuidv7(),
        userId,
        feedId,
        subscribedAt: new Date(),
        unsubscribedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      // Create a job
      await createJob({
        type: "fetch_feed",
        payload: { feedId },
        enabled: true,
      });

      // No active subscribers - job should be disabled
      const result = await syncFeedJobEnabled(feedId);

      expect(result).not.toBeNull();
      expect(result!.enabled).toBe(false);
    });
  });
});

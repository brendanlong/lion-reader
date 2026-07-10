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
  ensureFeedJob,
  updateFeedJobNextRun,
  claimFeedJob,
  claimSingletonJob,
  renewJobLease,
} from "../../src/server/jobs/queue";
import { startJobLeaseHeartbeat } from "../../src/server/jobs/worker";
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

  describe("claimSingletonJob", () => {
    it("self-creates and claims a singleton job when none exists", async () => {
      const job = await claimSingletonJob("monitor_feed_health");

      expect(job).not.toBeNull();
      expect(job!.type).toBe("monitor_feed_health");
      expect(job!.runningSince).not.toBeNull();

      // Exactly one row should exist for the type
      const rows = await listJobs({ type: "monitor_feed_health" });
      expect(rows).toHaveLength(1);
    });

    it("rejects non-singleton job types", async () => {
      await expect(claimSingletonJob("fetch_feed")).rejects.toThrow(
        "fetch_feed is not a singleton job type"
      );
    });

    it("creates only one row when workers race to self-create", async () => {
      // Simulate many workers all observing "no row exists" at once. The partial
      // unique index on jobs.type means only one INSERT can win; the losers fall
      // into the catch and either claim the row or get null (it's running).
      const claimPromises = Array.from({ length: 5 }, () => claimSingletonJob("renew_websub"));
      const results = await Promise.all(claimPromises);

      // Exactly one worker should have claimed the (newly created) job.
      const successfulClaims = results.filter((r) => r !== null);
      expect(successfulClaims).toHaveLength(1);

      // And crucially, only one row exists — no duplicate singleton rows.
      const rows = await listJobs({ type: "renew_websub" });
      expect(rows).toHaveLength(1);
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

  describe("renewJobLease", () => {
    it("keeps a long-running job from being reclaimed as stale", async () => {
      const job = await createJob({
        type: "fetch_feed",
        payload: { feedId: "test-feed-id" },
      });

      // Worker claims the job, then it runs long enough that running_since would
      // otherwise be considered stale.
      await claimJob();
      const staleTime = new Date(Date.now() - 10 * 60 * 1000); // 10 minutes ago
      await db
        .update(jobs)
        .set({ runningSince: staleTime })
        .where(sql`id = ${job.id}`);

      // Heartbeat renews the lease before another worker can reclaim it. The
      // worker's token is the running_since it last wrote (now back-dated).
      const renewed = await renewJobLease(job.id, staleTime);
      expect(renewed).not.toBeNull();
      // The returned token is the fresh running_since to fence the next renewal.
      expect(Date.now() - renewed!.getTime()).toBeLessThan(5000);

      // The job is no longer stale, so a second worker cannot claim it.
      const reclaimed = await claimJob();
      expect(reclaimed).toBeNull();

      // running_since should match the renewed token.
      const after = await getJob(job.id);
      expect(after!.runningSince!.getTime()).toBe(renewed!.getTime());
    });

    it("does not steal a job that another worker has reclaimed (fencing)", async () => {
      const job = await createJob({
        type: "fetch_feed",
        payload: { feedId: "test-feed-id" },
      });

      // Worker A claimed the job long ago and then stalled, so its lease token
      // (the running_since it holds in memory) is now stale.
      await claimJob();
      const aToken = new Date(Date.now() - 10 * 60 * 1000);
      await db
        .update(jobs)
        .set({ runningSince: aToken })
        .where(sql`id = ${job.id}`);

      // Worker B reclaims the now-stale job, taking ownership with a new token.
      const workerB = await claimJob();
      expect(workerB!.id).toBe(job.id);
      const bToken = workerB!.runningSince!;
      expect(bToken.getTime()).not.toBe(aToken.getTime());

      // Worker A wakes up and tries to renew with its stale token — it must fail
      // rather than overwrite Worker B's lease (no split-brain).
      const aRenew = await renewJobLease(job.id, aToken);
      expect(aRenew).toBeNull();

      // The lease still belongs to Worker B, untouched.
      const after = await getJob(job.id);
      expect(after!.runningSince!.getTime()).toBe(bToken.getTime());

      // Worker B can still renew its own lease.
      const bRenew = await renewJobLease(job.id, bToken);
      expect(bRenew).not.toBeNull();
    });

    it("does not resurrect the lease of a finished job", async () => {
      const job = await createJob({
        type: "fetch_feed",
        payload: { feedId: "test-feed-id" },
      });

      const claimed = await claimJob();
      await finishJob(job.id, {
        success: true,
        nextRunAt: new Date(Date.now() + 60 * 60 * 1000),
      });

      // A heartbeat that races with finishJob must be a no-op.
      const renewed = await renewJobLease(job.id, claimed!.runningSince!);
      expect(renewed).toBeNull();

      const after = await getJob(job.id);
      expect(after!.runningSince).toBeNull();
    });

    it("returns null for a non-existent job", async () => {
      const renewed = await renewJobLease(NON_EXISTENT_JOB_ID, new Date());
      expect(renewed).toBeNull();
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

    it("throws error for non-existent job", async () => {
      await expect(
        finishJob(NON_EXISTENT_JOB_ID, { success: true, nextRunAt: new Date() })
      ).rejects.toThrow(`Job not found: ${NON_EXISTENT_JOB_ID}`);
    });

    it("returns null without clobbering when the lease token no longer matches", async () => {
      const job = await createJob({
        type: "fetch_feed",
        payload: { feedId: "test-feed-id" },
      });

      // Worker A claims, stalls, and Worker B reclaims the job.
      const workerA = await claimJob();
      const aToken = workerA!.runningSince!;
      await db
        .update(jobs)
        .set({ runningSince: new Date(Date.now() - 10 * 60 * 1000) })
        .where(sql`id = ${job.id}`);
      const workerB = await claimJob();
      const bNextRunAt = new Date(Date.now() + 2 * 60 * 60 * 1000);
      await finishJob(workerB!.id, { success: true, nextRunAt: bNextRunAt });

      // Worker A's late finish, fenced on its stale token, must not overwrite
      // Worker B's result.
      const stale = await finishJob(job.id, {
        success: false,
        nextRunAt: new Date(Date.now() + 60 * 1000),
        error: "stale worker",
        expectedRunningSince: aToken,
      });
      expect(stale).toBeNull();

      // Worker B's scheduling/state is intact.
      const after = await getJob(job.id);
      expect(after!.nextRunAt!.getTime()).toBe(bNextRunAt.getTime());
      expect(after!.lastError).toBeNull();
      expect(after!.consecutiveFailures).toBe(0);
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
    it("ensureFeedJob creates a new job", async () => {
      const feedId = generateUuidv7();
      const job = await ensureFeedJob(feedId);

      expect(job.type).toBe("fetch_feed");
      expect(getJobPayload<"fetch_feed">(job).feedId).toBe(feedId);
    });

    it("ensureFeedJob returns existing job", async () => {
      const feedId = generateUuidv7();

      // Create an existing job
      await createJob({
        type: "fetch_feed",
        payload: { feedId },
      });

      // Should return existing, not create a new one
      const job = await ensureFeedJob(feedId);

      // Should only be one job
      const allJobs = await listJobs({ type: "fetch_feed" });
      expect(allJobs).toHaveLength(1);
      expect(job.id).toBe(allJobs[0].id);
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
  });

  describe("claimFeedJob (data-driven)", () => {
    it("does not claim feed job when no active subscribers", async () => {
      // Create a feed
      const feedId = generateUuidv7();
      await db.insert(feeds).values({
        id: feedId,
        type: "web",
        url: "https://example.com/feed.xml",
        createdAt: new Date(),
        updatedAt: new Date(),
      });

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
        type: "web",
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

      // Create a job due to run
      await createJob({
        type: "fetch_feed",
        payload: { feedId },
        nextRunAt: new Date(Date.now() - 1000), // 1 second ago
      });

      // Has subscriber - job should be claimed
      const claimed = await claimFeedJob();
      expect(claimed).not.toBeNull();
      expect(getJobPayload<"fetch_feed">(claimed!).feedId).toBe(feedId);
    });

    it("does not claim feed job when subscriber has unsubscribed", async () => {
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
        type: "web",
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
        type: "web",
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

  describe("startJobLeaseHeartbeat hard cap", () => {
    // These tests inject tiny heartbeat/cap intervals to exercise the wedged-
    // handler hard cap against the real database. The silent failure this
    // guards: a handler stuck on a never-settling await heartbeating its lease
    // forever, so the job is never reclaimed until a process restart.
    const quietLogger = { info: () => {}, warn: () => {}, error: () => {} };
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    const HEARTBEAT_MS = 30;
    const CAP_MS = 150;

    async function readRunningSince(jobId: string): Promise<Date | null> {
      const job = await getJob(jobId);
      return job?.runningSince ?? null;
    }

    it("renews until the cap, then stops so the job becomes reclaimable; a late finish on an unreclaimed job still commits", async () => {
      const job = await claimSingletonJob("renew_websub");
      expect(job?.runningSince).toBeInstanceOf(Date);

      const lease = startJobLeaseHeartbeat(job!, quietLogger, CAP_MS, HEARTBEAT_MS);

      // Before the cap: at least one renewal must advance running_since.
      const original = job!.runningSince!;
      let renewed: Date | null = null;
      for (let i = 0; i < 40 && !renewed; i++) {
        await sleep(25);
        const current = await readRunningSince(job!.id);
        if (current && current.getTime() > original.getTime()) {
          renewed = current;
        }
      }
      expect(renewed).not.toBeNull();

      // Past the cap (plus margin for an in-flight renewal to land): renewals
      // must have stopped — two samples a few heartbeats apart are identical.
      await sleep(CAP_MS + HEARTBEAT_MS * 3);
      const sample1 = await readRunningSince(job!.id);
      await sleep(HEARTBEAT_MS * 3);
      const sample2 = await readRunningSince(job!.id);
      expect(sample1?.getTime()).toBe(sample2?.getTime());

      // The controller keeps its last token (not nulled), so a handler that
      // settles after the cap — before anyone reclaims — still finishes
      // legitimately via the CAS fence.
      await lease.stop();
      const token = lease.currentToken();
      expect(token).not.toBeNull();
      expect(token!.getTime()).toBe(sample2!.getTime());

      const finished = await finishJob(job!.id, {
        success: true,
        nextRunAt: new Date(Date.now() + 60 * 60 * 1000),
        expectedRunningSince: token!,
      });
      expect(finished).not.toBeNull();
      expect((await getJob(job!.id))?.runningSince).toBeNull();
    });

    it("a post-cap finish no-ops when another worker has reclaimed the job", async () => {
      const job = await claimSingletonJob("renew_websub");
      expect(job?.runningSince).toBeInstanceOf(Date);

      const lease = startJobLeaseHeartbeat(job!, quietLogger, CAP_MS, HEARTBEAT_MS);

      // Wait until safely past the cap so the heartbeat has stopped renewing.
      await sleep(CAP_MS + HEARTBEAT_MS * 4);
      await lease.stop();
      const staleToken = lease.currentToken();
      expect(staleToken).not.toBeNull();

      // Simulate another worker reclaiming the now-stale job.
      const reclaimedAt = new Date(Date.now() + 1000);
      await db
        .update(jobs)
        .set({ runningSince: reclaimedAt })
        .where(sql`${jobs.id} = ${job!.id}`);

      // The wedged handler finally settles: its finish must no-op (CAS fails),
      // never clobbering the reclaimer's lease.
      const finished = await finishJob(job!.id, {
        success: true,
        nextRunAt: new Date(Date.now() + 60 * 60 * 1000),
        expectedRunningSince: staleToken!,
      });
      expect(finished).toBeNull();
      expect((await readRunningSince(job!.id))?.getTime()).toBe(reclaimedAt.getTime());
    });
  });
});

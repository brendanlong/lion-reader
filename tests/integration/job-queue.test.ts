/**
 * Integration tests for the Postgres-based job queue.
 *
 * These tests use a real database to verify job queue behavior,
 * including concurrent job claiming with row locking.
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "../../src/server/db";
import { jobs } from "../../src/server/db/schema";
import {
  createJob,
  claimJob,
  completeJob,
  failJob,
  getJob,
  getJobPayload,
  listJobs,
  calculateBackoff,
  resetStaleJobs,
  deleteCompletedJobs,
} from "../../src/server/jobs";

// A valid UUID that doesn't exist in the database
const NON_EXISTENT_JOB_ID = "00000000-0000-7000-8000-000000000000";

describe("Job Queue", () => {
  // Clean up jobs table before each test
  beforeEach(async () => {
    await db.delete(jobs);
  });

  // Clean up after all tests
  afterAll(async () => {
    await db.delete(jobs);
  });

  describe("createJob", () => {
    it("creates a job with default values", async () => {
      const job = await createJob({
        type: "fetch_feed",
        payload: { feedId: "test-feed-id" },
      });

      expect(job.id).toBeDefined();
      expect(job.type).toBe("fetch_feed");
      expect(job.status).toBe("pending");
      expect(job.attempts).toBe(0);
      expect(job.maxAttempts).toBe(3);
      expect(job.scheduledFor).toBeInstanceOf(Date);
      expect(job.startedAt).toBeNull();
      expect(job.completedAt).toBeNull();
      expect(job.lastError).toBeNull();

      const payload = getJobPayload<"fetch_feed">(job);
      expect(payload.feedId).toBe("test-feed-id");
    });

    it("creates a job with custom scheduledFor", async () => {
      const futureDate = new Date(Date.now() + 60 * 60 * 1000); // 1 hour from now

      const job = await createJob({
        type: "fetch_feed",
        payload: { feedId: "test-feed-id" },
        scheduledFor: futureDate,
      });

      expect(job.scheduledFor.getTime()).toBe(futureDate.getTime());
    });

    it("creates a job with custom maxAttempts", async () => {
      const job = await createJob({
        type: "fetch_feed",
        payload: { feedId: "test-feed-id" },
        maxAttempts: 5,
      });

      expect(job.maxAttempts).toBe(5);
    });

    it("creates a cleanup job with optional payload", async () => {
      const job = await createJob({
        type: "cleanup",
        payload: { olderThanDays: 30 },
      });

      expect(job.type).toBe("cleanup");
      const payload = getJobPayload<"cleanup">(job);
      expect(payload.olderThanDays).toBe(30);
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
      expect(claimed!.status).toBe("running");
      expect(claimed!.attempts).toBe(1);
      expect(claimed!.startedAt).toBeInstanceOf(Date);
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
        scheduledFor: futureDate,
      });

      const claimed = await claimJob();
      expect(claimed).toBeNull();
    });

    it("claims jobs in scheduledFor order (oldest first)", async () => {
      const now = new Date();
      const earlier = new Date(now.getTime() - 60 * 1000); // 1 minute ago

      // Create jobs in reverse order
      const job2 = await createJob({
        type: "fetch_feed",
        payload: { feedId: "feed-2" },
        scheduledFor: now,
      });

      const job1 = await createJob({
        type: "fetch_feed",
        payload: { feedId: "feed-1" },
        scheduledFor: earlier,
      });

      // Should claim the earlier job first
      const claimed1 = await claimJob();
      expect(claimed1!.id).toBe(job1.id);

      const claimed2 = await claimJob();
      expect(claimed2!.id).toBe(job2.id);
    });

    it("filters jobs by type", async () => {
      await createJob({
        type: "cleanup",
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

      // The cleanup job should still be pending
      const remainingJobs = await listJobs({ status: "pending" });
      expect(remainingJobs).toHaveLength(1);
      expect(remainingJobs[0].type).toBe("cleanup");
    });

    it("does not claim already running jobs", async () => {
      const created = await createJob({
        type: "fetch_feed",
        payload: { feedId: "test-feed-id" },
      });

      // Claim the job
      const claimed1 = await claimJob();
      expect(claimed1!.id).toBe(created.id);

      // Try to claim again - should get null
      const claimed2 = await claimJob();
      expect(claimed2).toBeNull();
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

  describe("completeJob", () => {
    it("marks a job as completed", async () => {
      await createJob({
        type: "fetch_feed",
        payload: { feedId: "test-feed-id" },
      });

      const claimed = await claimJob();
      const completed = await completeJob(claimed!.id);

      expect(completed.status).toBe("completed");
      expect(completed.completedAt).toBeInstanceOf(Date);
    });

    it("throws error for non-existent job", async () => {
      await expect(completeJob(NON_EXISTENT_JOB_ID)).rejects.toThrow(
        `Job not found: ${NON_EXISTENT_JOB_ID}`
      );
    });
  });

  describe("failJob", () => {
    it("reschedules job for retry when attempts < maxAttempts", async () => {
      const created = await createJob({
        type: "fetch_feed",
        payload: { feedId: "test-feed-id" },
        maxAttempts: 3,
      });

      // Claim and fail the job
      await claimJob();
      const failed = await failJob(created.id, "Connection timeout");

      expect(failed.status).toBe("pending");
      expect(failed.attempts).toBe(1); // Was incremented during claim
      expect(failed.lastError).toBe("Connection timeout");
      expect(failed.startedAt).toBeNull();
      expect(failed.scheduledFor.getTime()).toBeGreaterThan(Date.now());
    });

    it("marks job as permanently failed when attempts >= maxAttempts", async () => {
      const created = await createJob({
        type: "fetch_feed",
        payload: { feedId: "test-feed-id" },
        maxAttempts: 1,
      });

      // Claim and fail the job (attempt 1 of 1)
      await claimJob();
      const failed = await failJob(created.id, "Permanent failure");

      expect(failed.status).toBe("failed");
      expect(failed.attempts).toBe(1);
      expect(failed.lastError).toBe("Permanent failure");
      expect(failed.completedAt).toBeInstanceOf(Date);
    });

    it("uses exponential backoff for retry scheduling", async () => {
      const created = await createJob({
        type: "fetch_feed",
        payload: { feedId: "test-feed-id" },
        maxAttempts: 5,
      });

      // First attempt
      await claimJob();
      const beforeFail1 = Date.now();
      const failed1 = await failJob(created.id, "Error 1");

      // First retry should be ~1 minute later
      const delay1 = failed1.scheduledFor.getTime() - beforeFail1;
      expect(delay1).toBeGreaterThanOrEqual(55 * 1000); // Allow some tolerance
      expect(delay1).toBeLessThanOrEqual(65 * 1000);

      // Wait a bit and retry (simulating time passing by updating scheduledFor)
      await db
        .update(jobs)
        .set({ scheduledFor: new Date(Date.now() - 1000) })
        .where(sql`id = ${created.id}`);

      // Second attempt
      await claimJob();
      const beforeFail2 = Date.now();
      const failed2 = await failJob(created.id, "Error 2");

      // Second retry should be ~2 minutes later
      const delay2 = failed2.scheduledFor.getTime() - beforeFail2;
      expect(delay2).toBeGreaterThanOrEqual(110 * 1000); // Allow some tolerance
      expect(delay2).toBeLessThanOrEqual(130 * 1000);
    });

    it("throws error for non-existent job", async () => {
      await expect(failJob(NON_EXISTENT_JOB_ID, "Error")).rejects.toThrow(
        `Job not found: ${NON_EXISTENT_JOB_ID}`
      );
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
        type: "cleanup",
        payload: {},
      });

      const allJobs = await listJobs();
      expect(allJobs).toHaveLength(2);
    });

    it("filters by status", async () => {
      const job1 = await createJob({
        type: "fetch_feed",
        payload: { feedId: "feed-1" },
      });
      await createJob({
        type: "fetch_feed",
        payload: { feedId: "feed-2" },
      });

      // Complete job1
      await claimJob();
      await completeJob(job1.id);

      const pendingJobs = await listJobs({ status: "pending" });
      expect(pendingJobs).toHaveLength(1);

      const completedJobs = await listJobs({ status: "completed" });
      expect(completedJobs).toHaveLength(1);
    });

    it("filters by type", async () => {
      await createJob({
        type: "fetch_feed",
        payload: { feedId: "feed-1" },
      });
      await createJob({
        type: "cleanup",
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

  describe("deleteCompletedJobs", () => {
    it("deletes completed jobs older than specified date", async () => {
      const job = await createJob({
        type: "fetch_feed",
        payload: { feedId: "test-feed-id" },
      });

      await claimJob();
      await completeJob(job.id);

      // Delete jobs completed more than 1 hour ago (should not delete)
      const deleted1 = await deleteCompletedJobs(new Date(Date.now() - 60 * 60 * 1000));
      expect(deleted1).toBe(0);

      // Delete jobs completed before now + 1 hour (should delete)
      const deleted2 = await deleteCompletedJobs(new Date(Date.now() + 60 * 60 * 1000));
      expect(deleted2).toBe(1);

      const remainingJobs = await listJobs();
      expect(remainingJobs).toHaveLength(0);
    });
  });

  describe("resetStaleJobs", () => {
    it("resets jobs that have been running too long", async () => {
      const job = await createJob({
        type: "fetch_feed",
        payload: { feedId: "test-feed-id" },
      });

      // Claim the job
      await claimJob();

      // Manually set started_at to a long time ago
      const staleTime = new Date(Date.now() - 10 * 60 * 1000); // 10 minutes ago
      await db
        .update(jobs)
        .set({ startedAt: staleTime })
        .where(sql`id = ${job.id}`);

      // Reset stale jobs (timeout: 5 minutes)
      const resetCount = await resetStaleJobs(5 * 60 * 1000);
      expect(resetCount).toBe(1);

      // Job should be pending again
      const resetJob = await getJob(job.id);
      expect(resetJob!.status).toBe("pending");
      expect(resetJob!.startedAt).toBeNull();
    });

    it("does not reset recent running jobs", async () => {
      const job = await createJob({
        type: "fetch_feed",
        payload: { feedId: "test-feed-id" },
      });

      // Claim the job (just started)
      await claimJob();

      // Reset stale jobs (timeout: 5 minutes)
      const resetCount = await resetStaleJobs(5 * 60 * 1000);
      expect(resetCount).toBe(0);

      // Job should still be running
      const stillRunning = await getJob(job.id);
      expect(stillRunning!.status).toBe("running");
    });
  });

  describe("calculateBackoff", () => {
    it("doubles delay for each attempt", () => {
      expect(calculateBackoff(1)).toBe(60 * 1000); // 1 minute
      expect(calculateBackoff(2)).toBe(2 * 60 * 1000); // 2 minutes
      expect(calculateBackoff(3)).toBe(4 * 60 * 1000); // 4 minutes
      expect(calculateBackoff(4)).toBe(8 * 60 * 1000); // 8 minutes
      expect(calculateBackoff(5)).toBe(16 * 60 * 1000); // 16 minutes
    });

    it("caps at maximum backoff", () => {
      // Max is 256 minutes = 4 hours 16 minutes
      expect(calculateBackoff(10)).toBe(256 * 60 * 1000);
      expect(calculateBackoff(20)).toBe(256 * 60 * 1000);
    });
  });
});

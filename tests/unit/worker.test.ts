/**
 * Unit tests for the background job worker.
 *
 * These tests use dependency injection to test worker behavior
 * without requiring a real database.
 */

import { describe, it, expect } from "vitest";
import { createWorker, type WorkerLogger } from "../../src/server/jobs/worker";
import type { Job } from "../../src/server/db/schema";

/**
 * Creates a mock job for testing.
 */
function createMockJob(id: string, type: string = "fetch_feed"): Job {
  return {
    id,
    type,
    payload: JSON.stringify({ feedId: `feed-${id}` }),
    enabled: true,
    consecutiveFailures: 0,
    nextRunAt: new Date(),
    runningSince: new Date(),
    lastRunAt: null,
    lastError: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

/**
 * Creates a deferred promise that can be resolved externally.
 */
function createDeferred(): {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
} {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Wait for a short time to allow async operations to complete.
 */
function tick(ms: number = 10): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Silent logger for tests.
 */
const silentLogger: WorkerLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

describe("Worker", () => {
  describe("concurrency limit", () => {
    it("never runs more than concurrency limit jobs at once", async () => {
      const concurrency = 3;
      let currentlyRunning = 0;
      let maxConcurrentJobs = 0;
      const jobDeferreds: ReturnType<typeof createDeferred>[] = [];

      // Create 5 jobs
      const jobs = [
        createMockJob("1"),
        createMockJob("2"),
        createMockJob("3"),
        createMockJob("4"),
        createMockJob("5"),
      ];
      let jobIndex = 0;

      const worker = createWorker({
        concurrency,
        pollIntervalMs: 10,
        logger: silentLogger,
        _claimJob: async () => {
          if (jobIndex < jobs.length) {
            return jobs[jobIndex++];
          }
          return null;
        },
        _processJob: async () => {
          currentlyRunning++;
          maxConcurrentJobs = Math.max(maxConcurrentJobs, currentlyRunning);

          const deferred = createDeferred();
          jobDeferreds.push(deferred);
          await deferred.promise;

          currentlyRunning--;
        },
      });

      await worker.start();

      // Wait for worker to claim jobs
      await tick(50);

      // Should have started exactly 3 jobs (concurrency limit)
      expect(currentlyRunning).toBe(3);
      expect(maxConcurrentJobs).toBe(3);

      // Complete one job
      jobDeferreds[0].resolve();
      await tick(50);

      // Should now have 3 jobs running again (claimed a new one)
      expect(currentlyRunning).toBe(3);

      // Complete all jobs (including any new ones claimed)
      while (jobDeferreds.some((d) => d.promise)) {
        const unresolvedCount = jobDeferreds.length;
        for (const deferred of jobDeferreds) {
          deferred.resolve();
        }
        await tick(50);
        // If no new deferreds were added, we're done
        if (jobDeferreds.length === unresolvedCount) break;
      }

      await worker.stop();

      // Should never have exceeded concurrency limit
      expect(maxConcurrentJobs).toBe(3);
    });

    it("respects different concurrency values", async () => {
      let maxConcurrentJobs = 0;
      let currentlyRunning = 0;
      const jobDeferreds: ReturnType<typeof createDeferred>[] = [];

      // Create 10 jobs
      const jobs = Array.from({ length: 10 }, (_, i) => createMockJob(`${i}`));
      let jobIndex = 0;

      const worker = createWorker({
        concurrency: 7,
        pollIntervalMs: 10,
        logger: silentLogger,
        _claimJob: async () => {
          if (jobIndex < jobs.length) {
            return jobs[jobIndex++];
          }
          return null;
        },
        _processJob: async () => {
          currentlyRunning++;
          maxConcurrentJobs = Math.max(maxConcurrentJobs, currentlyRunning);

          const deferred = createDeferred();
          jobDeferreds.push(deferred);
          await deferred.promise;

          currentlyRunning--;
        },
      });

      await worker.start();
      await tick(50);

      expect(currentlyRunning).toBe(7);
      expect(maxConcurrentJobs).toBe(7);

      // Cleanup - resolve all deferreds including any new ones
      while (jobDeferreds.some((d) => d.promise)) {
        const unresolvedCount = jobDeferreds.length;
        for (const deferred of jobDeferreds) {
          deferred.resolve();
        }
        await tick(50);
        if (jobDeferreds.length === unresolvedCount) break;
      }
      await worker.stop();
    });
  });

  describe("graceful shutdown", () => {
    it("waits for in-flight jobs to complete before stopping", async () => {
      const jobDeferred = createDeferred();
      let jobCompleted = false;
      let jobsClaimed = 0;

      const worker = createWorker({
        concurrency: 1,
        pollIntervalMs: 10,
        logger: silentLogger,
        _claimJob: async () => {
          if (jobsClaimed === 0) {
            jobsClaimed++;
            return createMockJob("1");
          }
          return null;
        },
        _processJob: async () => {
          await jobDeferred.promise;
          jobCompleted = true;
        },
      });

      await worker.start();
      await tick(50);

      // Job should be running
      expect(worker.getStats().activeJobs).toBe(1);

      // Start stopping (don't await yet)
      const stopPromise = worker.stop();

      // Job should still be running
      await tick(10);
      expect(jobCompleted).toBe(false);
      expect(worker.getStats().activeJobs).toBe(1);

      // Complete the job
      jobDeferred.resolve();

      // Now stop should complete
      await stopPromise;

      expect(jobCompleted).toBe(true);
      expect(worker.getStats().activeJobs).toBe(0);
    });

    it("stops claiming new jobs after shutdown is requested", async () => {
      let claimCount = 0;
      const jobDeferreds: ReturnType<typeof createDeferred>[] = [];

      const worker = createWorker({
        concurrency: 2,
        pollIntervalMs: 10,
        logger: silentLogger,
        _claimJob: async () => {
          claimCount++;
          return createMockJob(`${claimCount}`);
        },
        _processJob: async () => {
          const deferred = createDeferred();
          jobDeferreds.push(deferred);
          await deferred.promise;
        },
      });

      await worker.start();
      await tick(50);

      const claimsBeforeStop = claimCount;

      // Start stopping
      const stopPromise = worker.stop();

      // Wait a bit - should not claim more jobs
      await tick(100);

      expect(claimCount).toBe(claimsBeforeStop);

      // Complete jobs to allow shutdown
      for (const deferred of jobDeferreds) {
        deferred.resolve();
      }

      await stopPromise;
    });
  });

  describe("slot refilling", () => {
    it("immediately claims a new job when a slot frees up", async () => {
      const jobDeferreds: ReturnType<typeof createDeferred>[] = [];
      let jobIndex = 0;

      const jobs = Array.from({ length: 5 }, (_, i) => createMockJob(`${i}`));

      const worker = createWorker({
        concurrency: 2,
        pollIntervalMs: 10, // Use short interval - test verifies immediate claiming via job completion
        logger: silentLogger,
        _claimJob: async () => {
          if (jobIndex < jobs.length) {
            return jobs[jobIndex++];
          }
          return null;
        },
        _processJob: async () => {
          const deferred = createDeferred();
          jobDeferreds.push(deferred);
          await deferred.promise;
        },
      });

      await worker.start();
      await tick(50);

      // Should have claimed 2 jobs immediately
      expect(jobIndex).toBe(2);

      // Complete first job - worker should claim next job immediately
      // (not waiting for poll interval since Promise.race resolves)
      const claimTimeBeforeResolve = Date.now();
      jobDeferreds[0].resolve();
      await tick(10);

      // Should have claimed a 3rd job immediately
      expect(jobIndex).toBe(3);
      expect(Date.now() - claimTimeBeforeResolve).toBeLessThan(100); // Verify it was fast

      // Complete second job
      jobDeferreds[1].resolve();
      await tick(10);

      // Should have claimed a 4th job immediately
      expect(jobIndex).toBe(4);

      // Cleanup - resolve all remaining deferreds
      while (jobDeferreds.some((d) => d.promise)) {
        const unresolvedCount = jobDeferreds.length;
        for (const deferred of jobDeferreds) {
          deferred.resolve();
        }
        await tick(50);
        if (jobDeferreds.length === unresolvedCount) break;
      }
      await worker.stop();
    });
  });

  describe("empty queue polling", () => {
    it("polls at configured interval when queue is empty", async () => {
      let claimCount = 0;

      const worker = createWorker({
        concurrency: 2,
        pollIntervalMs: 50,
        logger: silentLogger,
        _claimJob: async () => {
          claimCount++;
          return null; // Queue is always empty
        },
        _processJob: async () => {},
      });

      await worker.start();

      // Initial claim attempt
      await tick(20);
      expect(claimCount).toBe(1);

      // Wait for poll interval
      await tick(60);
      expect(claimCount).toBe(2);

      // Wait for another poll interval
      await tick(60);
      expect(claimCount).toBe(3);

      await worker.stop();
    });

    it("polls after delay when jobs complete and queue becomes empty", async () => {
      let claimCount = 0;
      let jobsReturned = 0;
      const jobDeferred = createDeferred();

      const worker = createWorker({
        concurrency: 2,
        pollIntervalMs: 100,
        logger: silentLogger,
        _claimJob: async () => {
          claimCount++;
          if (jobsReturned < 1) {
            jobsReturned++;
            return createMockJob("1");
          }
          return null;
        },
        _processJob: async () => {
          await jobDeferred.promise;
        },
      });

      await worker.start();
      await tick(20);

      // Should have claimed 1 job, then got null
      expect(claimCount).toBe(2);

      // Complete the job
      jobDeferred.resolve();
      await tick(20);

      // Should try to claim again immediately after job completes
      expect(claimCount).toBe(3);

      // Now queue is empty, should wait for poll interval
      const countAfterCompletion = claimCount;
      await tick(50);
      expect(claimCount).toBe(countAfterCompletion); // Still waiting

      await tick(100);
      expect(claimCount).toBeGreaterThan(countAfterCompletion); // Polled again

      await worker.stop();
    });
  });

  describe("worker stats", () => {
    it("tracks active jobs correctly", async () => {
      const jobDeferreds: ReturnType<typeof createDeferred>[] = [];
      let jobIndex = 0;
      const jobs = [createMockJob("1"), createMockJob("2"), createMockJob("3")];

      const worker = createWorker({
        concurrency: 5,
        pollIntervalMs: 10,
        logger: silentLogger,
        _claimJob: async () => {
          if (jobIndex < jobs.length) {
            return jobs[jobIndex++];
          }
          return null;
        },
        _processJob: async () => {
          const deferred = createDeferred();
          jobDeferreds.push(deferred);
          await deferred.promise;
        },
      });

      expect(worker.getStats().activeJobs).toBe(0);
      expect(worker.getStats().running).toBe(false);

      await worker.start();
      await tick(50);

      expect(worker.getStats().activeJobs).toBe(3);
      expect(worker.getStats().running).toBe(true);

      // Complete one job
      jobDeferreds[0].resolve();
      await tick(20);

      expect(worker.getStats().activeJobs).toBe(2);

      // Complete remaining jobs
      jobDeferreds[1].resolve();
      jobDeferreds[2].resolve();
      await tick(20);

      expect(worker.getStats().activeJobs).toBe(0);

      await worker.stop();
      expect(worker.getStats().running).toBe(false);
    });
  });

  describe("start and stop", () => {
    it("can be started and stopped multiple times", async () => {
      let claimCount = 0;

      const worker = createWorker({
        concurrency: 1,
        pollIntervalMs: 10,
        logger: silentLogger,
        _claimJob: async () => {
          claimCount++;
          return null;
        },
        _processJob: async () => {},
      });

      // First start/stop cycle
      await worker.start();
      expect(worker.isRunning()).toBe(true);
      await tick(30);
      await worker.stop();
      expect(worker.isRunning()).toBe(false);

      const countAfterFirstCycle = claimCount;

      // Second start/stop cycle
      await worker.start();
      expect(worker.isRunning()).toBe(true);
      await tick(30);
      await worker.stop();
      expect(worker.isRunning()).toBe(false);

      // Should have claimed more jobs in second cycle
      expect(claimCount).toBeGreaterThan(countAfterFirstCycle);
    });

    it("warns but does not error when starting an already running worker", async () => {
      const warnCalls: string[] = [];
      const testLogger: WorkerLogger = {
        info: () => {},
        warn: (msg) => warnCalls.push(msg),
        error: () => {},
      };

      const worker = createWorker({
        concurrency: 1,
        pollIntervalMs: 10,
        logger: testLogger,
        _claimJob: async () => null,
        _processJob: async () => {},
      });

      await worker.start();
      await worker.start(); // Should warn, not error

      expect(warnCalls).toContain("Worker is already running");

      await worker.stop();
    });

    it("warns but does not error when stopping a non-running worker", async () => {
      const warnCalls: string[] = [];
      const testLogger: WorkerLogger = {
        info: () => {},
        warn: (msg) => warnCalls.push(msg),
        error: () => {},
      };

      const worker = createWorker({
        concurrency: 1,
        pollIntervalMs: 10,
        logger: testLogger,
        _claimJob: async () => null,
        _processJob: async () => {},
      });

      await worker.stop(); // Should warn, not error

      expect(warnCalls).toContain("Worker is not running");
    });
  });
});

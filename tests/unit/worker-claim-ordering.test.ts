/**
 * Unit tests for the worker's claim-ordering strategy (createWorkerClaimJob).
 *
 * The failure mode this guards against is silent: if a sustained `fetch_feed`
 * backlog can starve the singleton maintenance jobs (renew_websub,
 * monitor_feed_health, cleanup), nothing errors — WebSub leases just quietly
 * lapse and retention stops running until someone notices weeks later. These
 * tests pin the round-robin contract: under a feed backlog that never drains,
 * singletons still get first crack every SINGLETON_PRIORITY_INTERVAL-th cycle,
 * and neither category is ever skipped on a cycle where the other is empty.
 *
 * The claim primitives are injected (WorkerClaimDeps), so these tests exercise
 * the real ordering logic with stub claim functions — no database, no mocks of
 * internal modules.
 */

import { describe, it, expect } from "vitest";
import {
  createWorkerClaimJob,
  FULL_CONTENT_PRIORITY_CYCLE,
  SINGLETON_PRIORITY_INTERVAL,
  type WorkerClaimDeps,
} from "@/server/jobs/worker";
import { SINGLETON_JOB_TYPES, type JobType } from "@/server/jobs/queue";
import { createWorkerCore } from "@/server/jobs/worker-core";
import type { Job } from "@/server/db/schema";

/** Minimal fake Job — the strategy only passes it through. */
function fakeJob(type: JobType): Job {
  return { id: `job-${type}`, type } as unknown as Job;
}

interface ClaimHarness {
  claimJob: () => Promise<Job | null>;
  /**
   * Runs claimJob n times; returns each call's result plus, per call, the
   * ordered list of claim primitives that were consulted.
   */
  run: (n: number) => Promise<{ perCall: string[][]; results: (Job | null)[] }>;
}

/**
 * Builds the claim strategy over stub primitives that record consultation
 * order. `feedHasJobs` / `dueSingletons` / `regularHasJobs` /
 * `fullContentHasJobs` control what each primitive returns.
 */
function makeHarness(config: {
  regularHasJobs?: boolean;
  feedHasJobs?: boolean;
  dueSingletons?: JobType[];
  fullContentHasJobs?: boolean;
}): ClaimHarness {
  let current: string[] = [];
  const deps: WorkerClaimDeps = {
    claimRegular: async () => {
      current.push("regular");
      return config.regularHasJobs ? fakeJob("process_opml_import") : null;
    },
    claimFeed: async () => {
      current.push("feed");
      return config.feedHasJobs ? fakeJob("fetch_feed") : null;
    },
    claimSingleton: async (type) => {
      current.push(`singleton(${type})`);
      return config.dueSingletons?.includes(type) ? fakeJob(type) : null;
    },
    claimFullContent: async () => {
      current.push("fullContent");
      return config.fullContentHasJobs ? fakeJob("fetch_full_content") : null;
    },
  };
  const claimJob = createWorkerClaimJob(deps);
  return {
    claimJob,
    async run(n) {
      const perCall: string[][] = [];
      const results: (Job | null)[] = [];
      for (let i = 0; i < n; i++) {
        current = [];
        results.push(await claimJob());
        perCall.push(current);
      }
      return { perCall, results };
    },
  };
}

describe("createWorkerClaimJob", () => {
  it("under a sustained feed backlog, singletons still get first crack every Nth cycle", async () => {
    const harness = makeHarness({ feedHasJobs: true, dueSingletons: [] });

    const cycles = SINGLETON_PRIORITY_INTERVAL * 2;
    const { perCall, results } = await harness.run(cycles);

    // Every call claimed a feed job (singletons had nothing due).
    expect(results.every((j) => j?.type === "fetch_feed")).toBe(true);

    for (let i = 0; i < cycles; i++) {
      const consulted = perCall[i];
      const singletonsFirst = i % SINGLETON_PRIORITY_INTERVAL === 0;
      if (singletonsFirst) {
        // Singleton cycle: all singleton types consulted BEFORE the feed claim.
        const feedIdx = consulted.indexOf("feed");
        const singletonIdxs = consulted
          .map((c, idx) => (c.startsWith("singleton(") ? idx : -1))
          .filter((idx) => idx >= 0);
        expect(singletonIdxs.length).toBe(SINGLETON_JOB_TYPES.length);
        expect(Math.max(...singletonIdxs)).toBeLessThan(feedIdx);
      } else {
        // Feed-first cycle with a feed job available: feed short-circuits,
        // singletons are never consulted.
        expect(consulted.filter((c) => c.startsWith("singleton("))).toEqual([]);
        expect(consulted).toContain("feed");
      }
    }
  });

  it("claims a due singleton instead of a feed job on the singleton-priority cycle", async () => {
    const due = SINGLETON_JOB_TYPES[0];
    const harness = makeHarness({ feedHasJobs: true, dueSingletons: [due] });

    const { results } = await harness.run(SINGLETON_PRIORITY_INTERVAL);

    // Cycle 0 is singletons-first: the due singleton wins over the feed backlog.
    expect(results[0]?.type).toBe(due);
    // Remaining cycles in the interval are feeds-first: feed jobs win.
    for (let i = 1; i < SINGLETON_PRIORITY_INTERVAL; i++) {
      expect(results[i]?.type).toBe("fetch_feed");
    }
  });

  it("falls through to feeds when no singleton is due on a singleton-first cycle", async () => {
    const harness = makeHarness({ feedHasJobs: true, dueSingletons: [] });
    const { results, perCall } = await harness.run(1);
    // Nothing skipped: singletons consulted, none due, feed claimed same cycle.
    expect(results[0]?.type).toBe("fetch_feed");
    expect(perCall[0].some((c) => c.startsWith("singleton("))).toBe(true);
  });

  it("falls through to singletons when the feed queue is empty on a feeds-first cycle", async () => {
    const due = SINGLETON_JOB_TYPES[1];
    const harness = makeHarness({ feedHasJobs: false, dueSingletons: [due] });
    const { results } = await harness.run(2);
    // Call index 1 is feeds-first; feed empty → singleton claimed anyway.
    expect(results[1]?.type).toBe(due);
  });

  it("regular jobs always take priority over both categories", async () => {
    const harness = makeHarness({
      regularHasJobs: true,
      feedHasJobs: true,
      dueSingletons: [...SINGLETON_JOB_TYPES],
    });
    const { results, perCall } = await harness.run(2);
    expect(results.every((j) => j?.type === "process_opml_import")).toBe(true);
    // Neither feed nor singleton consulted when a regular job was claimed.
    expect(perCall.flat().filter((c) => c !== "regular")).toEqual([]);
  });

  describe("fetch_full_content (third-party driven, so no priority over polls)", () => {
    it("on a single-slot worker under a backlog everywhere, gets one claim in each interval", async () => {
      // Production runs one worker slot, so claim order is the only thing that
      // divides it. Drive the real worker loop at concurrency 1 with every
      // category permanently backlogged and record what actually ran.
      const due = SINGLETON_JOB_TYPES[0];
      const deps: WorkerClaimDeps = {
        claimRegular: async () => null,
        claimFeed: async () => fakeJob("fetch_feed"),
        claimSingleton: async (type) => (type === due ? fakeJob(due) : null),
        claimFullContent: async () => fakeJob("fetch_full_content"),
      };
      const target = SINGLETON_PRIORITY_INTERVAL * 3;
      const ran: string[] = [];
      let done!: () => void;
      const finished = new Promise<void>((resolve) => (done = resolve));
      let inFlight = 0;
      let maxInFlight = 0;
      const worker = createWorkerCore({
        pollIntervalMs: 1,
        concurrency: 1,
        logger: { info: () => {}, warn: () => {}, error: () => {} },
        claimJob: createWorkerClaimJob(deps),
        processJob: async (job) => {
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await Promise.resolve();
          if (ran.length < target) {
            ran.push(job.type);
            if (ran.length === target) done();
          }
          inFlight--;
        },
      });
      await worker.start();
      await finished;
      await worker.stop();

      expect(maxInFlight).toBe(1);
      for (let i = 0; i < target; i += SINGLETON_PRIORITY_INTERVAL) {
        const interval = ran.slice(i, i + SINGLETON_PRIORITY_INTERVAL);
        expect(interval.filter((t) => t === "fetch_full_content")).toHaveLength(1);
        expect(interval.filter((t) => t === due)).toHaveLength(1);
        expect(interval.filter((t) => t === "fetch_feed")).toHaveLength(
          SINGLETON_PRIORITY_INTERVAL - 2
        );
      }
    });

    it("goes first only on its own cycle", async () => {
      const harness = makeHarness({ feedHasJobs: true, fullContentHasJobs: true });
      const cycles = SINGLETON_PRIORITY_INTERVAL * 2;
      const { results } = await harness.run(cycles);
      for (let i = 0; i < cycles; i++) {
        expect(results[i]?.type).toBe(
          i % SINGLETON_PRIORITY_INTERVAL === FULL_CONTENT_PRIORITY_CYCLE
            ? "fetch_full_content"
            : "fetch_feed"
        );
      }
    });

    it("is claimed on any cycle when feeds and singletons have nothing", async () => {
      const harness = makeHarness({ fullContentHasJobs: true });
      const { results } = await harness.run(SINGLETON_PRIORITY_INTERVAL);
      expect(results.every((j) => j?.type === "fetch_full_content")).toBe(true);
    });

    it("falls through to feeds on its own cycle when it has nothing", async () => {
      const harness = makeHarness({ feedHasJobs: true });
      const { results, perCall } = await harness.run(FULL_CONTENT_PRIORITY_CYCLE + 1);
      expect(results[FULL_CONTENT_PRIORITY_CYCLE]?.type).toBe("fetch_feed");
      expect(perCall[FULL_CONTENT_PRIORITY_CYCLE]).toEqual(["regular", "fullContent", "feed"]);
    });
  });
});

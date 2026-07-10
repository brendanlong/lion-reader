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
  SINGLETON_PRIORITY_INTERVAL,
  type WorkerClaimDeps,
} from "@/server/jobs/worker";
import { SINGLETON_JOB_TYPES, type JobType } from "@/server/jobs/queue";
import type { Job } from "@/server/db/schema";

/** Minimal fake Job — the strategy only passes it through. */
function fakeJob(type: JobType): Job {
  return { id: `job-${type}`, type } as unknown as Job;
}

interface ClaimHarness {
  claimJob: (options?: { types?: JobType[] }) => Promise<Job | null>;
  /**
   * Runs claimJob n times; returns each call's result plus, per call, the
   * ordered list of claim primitives that were consulted.
   */
  run: (
    n: number,
    options?: { types?: JobType[] }
  ) => Promise<{ perCall: string[][]; results: (Job | null)[] }>;
}

/**
 * Builds the claim strategy over stub primitives that record consultation
 * order. `feedHasJobs` / `dueSingletons` / `regularHasJobs` control what each
 * primitive returns.
 */
function makeHarness(config: {
  regularHasJobs?: boolean;
  feedHasJobs?: boolean;
  dueSingletons?: JobType[];
}): ClaimHarness {
  let current: string[] = [];
  const deps: WorkerClaimDeps = {
    claimRegular: async ({ types }) => {
      current.push(`regular(${types.join(",")})`);
      return config.regularHasJobs ? fakeJob(types[0]) : null;
    },
    claimFeed: async () => {
      current.push("feed");
      return config.feedHasJobs ? fakeJob("fetch_feed") : null;
    },
    claimSingleton: async (type) => {
      current.push(`singleton(${type})`);
      return config.dueSingletons?.includes(type) ? fakeJob(type) : null;
    },
  };
  const claimJob = createWorkerClaimJob(deps);
  return {
    claimJob,
    async run(n, options) {
      const perCall: string[][] = [];
      const results: (Job | null)[] = [];
      for (let i = 0; i < n; i++) {
        current = [];
        results.push(await claimJob(options));
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
    expect(perCall.flat().filter((c) => c !== "regular(process_opml_import)")).toEqual([]);
  });

  describe("jobTypes filtering (must match pre-round-robin behavior)", () => {
    it('types: ["fetch_feed"] consults only the feed claim', async () => {
      const harness = makeHarness({ feedHasJobs: true, dueSingletons: [...SINGLETON_JOB_TYPES] });
      const { results, perCall } = await harness.run(SINGLETON_PRIORITY_INTERVAL, {
        types: ["fetch_feed"],
      });
      expect(results.every((j) => j?.type === "fetch_feed")).toBe(true);
      expect(perCall.flat()).toEqual(
        Array.from({ length: SINGLETON_PRIORITY_INTERVAL }, () => "feed")
      );
    });

    it('types: ["process_opml_import"] consults only the regular claim', async () => {
      const harness = makeHarness({ regularHasJobs: false, feedHasJobs: true });
      const { results, perCall } = await harness.run(2, { types: ["process_opml_import"] });
      expect(results).toEqual([null, null]);
      expect(perCall.flat()).toEqual([
        "regular(process_opml_import)",
        "regular(process_opml_import)",
      ]);
    });

    it("a singleton type in `types` consults that singleton and not feeds", async () => {
      const target = SINGLETON_JOB_TYPES[0];
      const harness = makeHarness({ feedHasJobs: true, dueSingletons: [target] });
      const { results, perCall } = await harness.run(1, { types: [target] });
      expect(results[0]?.type).toBe(target);
      // The generic regular claim still sees the type (pre-existing behavior),
      // then the singleton claim wins; feeds and other singletons untouched.
      expect(perCall[0]).toEqual([`regular(${target})`, `singleton(${target})`]);
    });
  });
});

/**
 * Benchmark configuration — the knobs that make the synthetic workload match
 * real Lion Reader usage.
 *
 * The numbers below are DEFAULTS / ESTIMATES. Run `bench/characterize-prod.sql`
 * against production and drop the results into `bench/prod-params.json` to
 * override them with real figures (loaded automatically if the file exists).
 *
 * See bench/README.md for the methodology.
 */

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface WorkloadParams {
  /** How each seeded user's data is shaped (drives bench/seed-bench.ts). */
  seed: {
    /** Subscriptions per user (≈ prod p50). */
    subsPerUser: number;
    /** Feeds shared per subscription cluster. Each user gets its own feeds. */
    entriesPerFeed: number;
    /** Fraction of a user's entries already marked read (0..1). */
    readFraction: number;
    /** Fraction starred (0..1). */
    starredFraction: number;
    /** Tags per user. */
    tagsPerUser: number;
    /** Uncategorized (untagged) subscriptions per user. */
    uncategorizedSubs: number;
  };

  /**
   * How a logged-in user behaves in one "session" (drives the action mix).
   * A session = one page load bundle + a browse loop.
   */
  session: {
    /** entries.list page size the client requests. */
    listLimit: number;
    /** Extra list pages fetched by scrolling, per session. */
    scrollPages: number;
    /** Articles opened per session (each = get + single markRead). */
    articlesOpened: number;
    /** Probability an opened article gets starred. */
    starProbability: number;
    /** Probability the session issues a batch markRead (mark several read). */
    batchMarkReadProbability: number;
    /** Batch size when it does. */
    batchMarkReadSize: number;
    /** Probability the session ends with a mark-all-read (rare, expensive). */
    markAllReadProbability: number;
    /** Whether each VU holds an SSE connection open for the session. */
    holdSse: boolean;
    /** Think time (ms) between actions — models human reading. [min,max] */
    thinkMs: [number, number];
    /** Pause (ms) between one session ending and the next starting. [min,max] */
    betweenSessionsMs: [number, number];
  };

  /**
   * Translating a measured "peak concurrent active users" ceiling into a
   * "total registered users" ceiling. Derived from prod recency data
   * (characterize-prod.sql section 2).
   *
   * registeredCeiling = concurrentCeiling / peakConcurrentFraction
   *
   * peakConcurrentFraction = (peak simultaneous users) / (total registered).
   * We estimate it from: what fraction of registered users are active in a
   * 5-minute window at peak. If prod is too small to observe a real peak, we
   * fall back to an industry heuristic (see README).
   */
  translation: {
    /** Fraction of registered users concurrently active at peak. */
    peakConcurrentFraction: number;
  };
}

const DEFAULTS: WorkloadParams = {
  seed: {
    subsPerUser: 40,
    entriesPerFeed: 50,
    readFraction: 0.6,
    starredFraction: 0.01,
    tagsPerUser: 5,
    uncategorizedSubs: 8,
  },
  session: {
    listLimit: 50,
    scrollPages: 2,
    articlesOpened: 5,
    starProbability: 0.15,
    batchMarkReadProbability: 0.4,
    batchMarkReadSize: 10,
    markAllReadProbability: 0.05,
    holdSse: true,
    thinkMs: [500, 3000],
    betweenSessionsMs: [1000, 5000],
  },
  translation: {
    // Placeholder: assume 5% of registered users are concurrently active at
    // peak (typical for a consumer reader app). Replaced by prod-derived value.
    peakConcurrentFraction: 0.05,
  },
};

function deepMerge<T>(base: T, override: Partial<T> | undefined): T {
  if (!override) return base;
  const out = { ...base } as Record<string, unknown>;
  for (const [k, v] of Object.entries(override)) {
    const bv = (base as Record<string, unknown>)[k];
    if (v && typeof v === "object" && !Array.isArray(v) && bv && typeof bv === "object") {
      out[k] = deepMerge(bv, v as Record<string, unknown>);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out as T;
}

/** Loads params, overlaying bench/prod-params.json when present. */
export function loadWorkload(): WorkloadParams {
  const path = join(__dirname, "prod-params.json");
  if (existsSync(path)) {
    try {
      const override = JSON.parse(readFileSync(path, "utf8")) as Partial<WorkloadParams>;
      return deepMerge(DEFAULTS, override);
    } catch (err) {
      console.warn(`[config] failed to read prod-params.json, using defaults:`, err);
    }
  }
  return DEFAULTS;
}

/** Concurrency staircase for the load test (VUs per stage). */
export const DEFAULT_STAGES = [5, 10, 25, 50, 100, 200, 400];

/** Seconds each stage runs. */
export const DEFAULT_STAGE_SECONDS = 30;

/**
 * Pass/fail gate for a stage. The "knee" is the largest VU count whose stage
 * still passes.
 *
 * NOTE on which signals to trust: the load generator is a single Node process,
 * so above a few hundred VUs on a big host ITS event loop (superjson-decoding
 * list responses) inflates *client-side* latency before the server saturates.
 * We therefore gate primarily on SERVER-SIDE truth — the app's own tRPC latency
 * histogram and pg-pool-waiting gauge — and keep the client p95 only as a loose
 * sanity ceiling. When a stage fails, the summary reports whether the SERVER
 * saturated (pool queued / server latency climbed) or the run was generator-
 * bound (server still flat) so local numbers aren't misread.
 */
export const SLO = {
  /** Server-side mean latency for entries.list must stay under this (ms). */
  serverListMeanMs: 150,
  /** Any queuing for a pg connection = DB saturation → fail. */
  maxPoolWaiting: 0,
  /** Overall client error rate must stay under this (fraction). */
  maxErrorRate: 0.01,
  /** Loose client-side p95 sanity ceiling (ms); breaching alone is a soft warn. */
  clientListP95Ms: 2000,
};

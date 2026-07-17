/**
 * Worker (feed-fetch) throughput benchmark.
 *
 * Answers: "how many feeds can one worker keep polled before it falls behind?"
 *
 * Method: seed M feeds (each with an active subscriber) all DUE now, pointed at
 * a local mock feed server, then run the real worker (`dist/worker.js`) and time
 * how fast it drains the backlog. Two phases per concurrency level:
 *   - FRESH: first poll returns 200 + `itemsPerFeed` items → full parse + entry
 *     processing + sanitize + user_entries fanout. This is the worst case
 *     (cold start / mass subscribe / every feed updated at once).
 *   - NOT-MODIFIED: re-poll after the worker stored our ETag → 304, the
 *     steady-state case (most real polls find nothing new).
 * Sweeps WORKER_CONCURRENCY to show how I/O concurrency lifts throughput.
 *
 * Runs against the TEST db so it doesn't touch the capacity seed. Example:
 *   FEEDS=3000 CONCURRENCIES=1,3,8,16 ITEMS_PER_FEED=25 MOCK_LATENCY_MS=100 \
 *     dotenv -e .env.local-services.test -- tsx bench/worker/worker-bench.ts
 *
 * The worker child is spawned with ALLOW_PRIVATE_NETWORK_FETCH=true so it can
 * reach 127.0.0.1.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Pool } from "pg";
import { startMockFeedServer, type MockFeedServer } from "./mock-feed-server";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");

const FEEDS = Number(process.env.FEEDS ?? 3000);
const CONCURRENCIES = (process.env.CONCURRENCIES ?? "1,3,8,16")
  .split(",")
  .map((s) => Number(s.trim()))
  .filter((n) => n > 0);
const ITEMS_PER_FEED = Number(process.env.ITEMS_PER_FEED ?? 25);
const MOCK_LATENCY_MS = Number(process.env.MOCK_LATENCY_MS ?? 0);
const DATABASE_URL = process.env.DATABASE_URL;
const REDIS_URL = process.env.REDIS_URL;
const WORKER_METRICS = "http://127.0.0.1:9092/metrics";
const WORKER_HEALTH = "http://127.0.0.1:9092/health";

if (!DATABASE_URL || !REDIS_URL) {
  console.error(
    "DATABASE_URL + REDIS_URL required (prefix with dotenv -e .env.local-services.test --)"
  );
  process.exit(1);
}

const pool = new Pool({ connectionString: DATABASE_URL, max: 8 });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function seedAll(mockPort: number): Promise<void> {
  await pool.query(
    `TRUNCATE jobs, user_entries, entries, subscription_tags, subscriptions, feeds, users CASCADE`
  );
  await pool.query(
    `INSERT INTO users (id, email, created_at, updated_at)
     VALUES (gen_random_uuid(), 'worker-bench@example.com', now(), now())`
  );
  await pool.query(
    `INSERT INTO feeds (id, type, url, title, created_at, updated_at)
     SELECT gen_random_uuid(), 'web',
            'http://127.0.0.1:' || $1::text || '/feed/' || i,
            'Bench Feed ' || i, now(), now()
     FROM generate_series(1, $2) AS i`,
    [mockPort, FEEDS]
  );
  await pool.query(
    `INSERT INTO subscriptions (id, user_id, feed_id, subscribed_at, created_at, updated_at)
     SELECT gen_random_uuid(), (SELECT id FROM users LIMIT 1), f.id, now(), now(), now()
     FROM feeds f`
  );
  await pool.query(
    `INSERT INTO jobs (id, type, payload, next_run_at, created_at, updated_at)
     SELECT gen_random_uuid(), 'fetch_feed',
            jsonb_build_object('feedId', f.id::text),
            now() - interval '1 second', now(), now()
     FROM feeds f`
  );
  await pool.query(`ANALYZE feeds, subscriptions, jobs`);
}

/** Re-arm every fetch_feed job as due now (keeps feed ETag → 304 path). */
async function resetDue(): Promise<void> {
  await pool.query(
    `UPDATE jobs SET next_run_at = now() - interval '1 second', running_since = NULL
     WHERE type = 'fetch_feed'`
  );
}

async function dueBacklog(): Promise<number> {
  const r = await pool.query<{ n: string }>(
    `SELECT count(*)::int AS n FROM jobs WHERE type = 'fetch_feed' AND next_run_at <= now()`
  );
  return Number(r.rows[0].n);
}

async function fetchWorkerMetrics(): Promise<string> {
  try {
    const r = await fetch(WORKER_METRICS, { signal: AbortSignal.timeout(4000) });
    return await r.text();
  } catch {
    return "";
  }
}

async function waitForWorkerHealth(timeoutMs: number): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const r = await fetch(WORKER_HEALTH, { signal: AbortSignal.timeout(2000) });
      if (r.ok) return true;
    } catch {
      /* not up yet */
    }
    await sleep(300);
  }
  return false;
}

function spawnWorker(concurrency: number): ChildProcess {
  return spawn("node", ["dist/worker.js"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      DATABASE_URL,
      REDIS_URL,
      NODE_ENV: "production",
      METRICS_ENABLED: "true",
      ALLOW_PRIVATE_NETWORK_FETCH: "true",
      WORKER_CONCURRENCY: String(concurrency),
      WORKER_POLL_INTERVAL_MS: "100",
      FEED_MIN_FETCH_INTERVAL_MINUTES: "60",
    },
    stdio: "ignore",
  });
}

async function killWorker(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.kill("SIGKILL");
    setTimeout(resolve, 5000); // safety
  });
}

/** Drain the current due backlog, returning throughput (feeds/sec). */
async function drain(): Promise<{ feedsPerSec: number; elapsedS: number; drained: number }> {
  let t0: number | null = null;
  let backlogAtT0 = 0;
  const initial = await dueBacklog();
  for (;;) {
    const b = await dueBacklog();
    if (t0 === null && b < initial) {
      t0 = Date.now();
      backlogAtT0 = b;
    }
    if (b === 0) {
      const t1 = Date.now();
      if (t0 === null) return { feedsPerSec: 0, elapsedS: 0, drained: 0 };
      const elapsedS = (t1 - t0) / 1000;
      return {
        feedsPerSec: elapsedS > 0 ? backlogAtT0 / elapsedS : 0,
        elapsedS,
        drained: backlogAtT0,
      };
    }
    await sleep(200);
  }
}

async function runConcurrency(concurrency: number, mock: MockFeedServer): Promise<void> {
  // Fresh seed (no ETag, no entries) so phase 1 does full processing.
  await seedAll(mock.port);
  mock.reset();
  const worker = spawnWorker(concurrency);
  const healthy = await waitForWorkerHealth(20000);
  if (!healthy) {
    console.log(`  [c=${concurrency}] worker health never came up — skipping`);
    await killWorker(worker);
    return;
  }

  const m0 = await fetchWorkerMetrics();
  const fresh = await drain();
  const m1 = await fetchWorkerMetrics();
  const freshStats = mock.stats();

  // Steady-state: re-arm due; worker now sends If-None-Match → mock 304.
  mock.reset();
  await resetDue();
  const notmod = await drain();
  const m2 = await fetchWorkerMetrics();
  const notmodStats = mock.stats();

  await killWorker(worker);

  // Per-fetch server-side latency from the histogram (delta), if present.
  const fetchSum = (t: string) =>
    Number((t.match(/^feed_fetch_duration_seconds_sum\s+([0-9.eE+-]+)/m) ?? [])[1] ?? 0);
  const fetchCnt = (t: string) =>
    Number((t.match(/^feed_fetch_duration_seconds_count\s+([0-9.eE+-]+)/m) ?? [])[1] ?? 0);
  const freshMeanMs =
    fetchCnt(m1) > fetchCnt(m0)
      ? ((fetchSum(m1) - fetchSum(m0)) / (fetchCnt(m1) - fetchCnt(m0))) * 1000
      : 0;
  const notmodMeanMs =
    fetchCnt(m2) > fetchCnt(m1)
      ? ((fetchSum(m2) - fetchSum(m1)) / (fetchCnt(m2) - fetchCnt(m1))) * 1000
      : 0;

  const perHourFresh = Math.round(fresh.feedsPerSec * 3600);
  const perHourNotmod = Math.round(notmod.feedsPerSec * 3600);

  console.log(
    `\n  concurrency=${concurrency}` +
      `\n    FRESH (200, ${ITEMS_PER_FEED} new items/feed): ${fresh.feedsPerSec.toFixed(1)} feeds/s ` +
      `(${fresh.drained} in ${fresh.elapsedS.toFixed(1)}s, mock 200=${freshStats.served200}) ` +
      `perFetch≈${freshMeanMs.toFixed(0)}ms` +
      `\n      → sustains ~${perHourFresh.toLocaleString()} feeds at hourly cadence (worst case)` +
      `\n    NOT-MODIFIED (304): ${notmod.feedsPerSec.toFixed(1)} feeds/s ` +
      `(mock 304=${notmodStats.served304}, 200=${notmodStats.served200}) perFetch≈${notmodMeanMs.toFixed(0)}ms` +
      `\n      → sustains ~${perHourNotmod.toLocaleString()} feeds at hourly cadence (steady state)`
  );
}

async function main() {
  console.log(
    `Worker throughput benchmark: FEEDS=${FEEDS} items/feed=${ITEMS_PER_FEED} ` +
      `mockLatency=${MOCK_LATENCY_MS}ms concurrencies=[${CONCURRENCIES.join(", ")}]`
  );
  const mock = await startMockFeedServer({
    itemsPerFeed: ITEMS_PER_FEED,
    latencyMs: MOCK_LATENCY_MS,
  });
  console.log(`Mock feed server on 127.0.0.1:${mock.port}`);

  for (const c of CONCURRENCIES) {
    await runConcurrency(c, mock);
  }

  mock.server.close();
  await pool.end();
  console.log(`\nDone.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

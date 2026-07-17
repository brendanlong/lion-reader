/**
 * Lion Reader load driver.
 *
 * Replays a realistic logged-in-user workload (page-load bundle + browse loop)
 * against a running app, ramping concurrency through a staircase of "virtual
 * users" (VUs) to find the capacity knee: the largest VU count whose stage
 * still meets the SLO (bench/config.ts).
 *
 * Each VU authenticates as a distinct seeded user (bench/sessions.json) using
 * the app's real tRPC client, so the wire format matches production exactly.
 * At each stage boundary we also scrape the server's own Prometheus metrics
 * (server-side tRPC latency + pg pool saturation) for ground truth independent
 * of client-side timing.
 *
 * Usage:
 *   BASE_URL=http://127.0.0.1:3000 METRICS_URL=http://127.0.0.1:9091/metrics \
 *     STAGES=5,10,25,50,100,200 STAGE_SECONDS=30 tsx bench/loadtest.ts
 *
 * Output: a table per stage + a final capacity summary (JSON to
 * bench/results-<label>.json if RESULT_LABEL is set).
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { makeClient, openSse, type BenchClient } from "./lib/trpc-client";
import { loadWorkload, DEFAULT_STAGES, DEFAULT_STAGE_SECONDS, SLO } from "./config";
// The load generator's HTTP pool (large, so it never bottlenecks) lives in
// ./lib/trpc-client via an explicit undici dispatcher.

const __dirname = dirname(fileURLToPath(import.meta.url));

const BASE_URL = process.env.BASE_URL ?? "http://127.0.0.1:3000";
const METRICS_URL = process.env.METRICS_URL ?? "";
const STAGES = (
  process.env.STAGES?.split(",").map((s) => Number(s.trim())) ?? DEFAULT_STAGES
).filter((n) => n > 0);
const STAGE_SECONDS = Number(process.env.STAGE_SECONDS ?? DEFAULT_STAGE_SECONDS);
const RESULT_LABEL = process.env.RESULT_LABEL ?? "";

const workload = loadWorkload();
const S = workload.session;

interface SessionInfo {
  userId: string;
  sessionToken: string;
}

// ---------------------------------------------------------------------------
// Metrics recording
// ---------------------------------------------------------------------------

class Recorder {
  private samples = new Map<string, number[]>();
  errors = 0;
  ok = 0;

  record(action: string, ms: number): void {
    let arr = this.samples.get(action);
    if (!arr) {
      arr = [];
      this.samples.set(action, arr);
    }
    arr.push(ms);
  }

  reset(): void {
    this.samples.clear();
    this.errors = 0;
    this.ok = 0;
  }

  stats(action: string): { n: number; p50: number; p95: number; p99: number; max: number } {
    const arr = (this.samples.get(action) ?? []).slice().sort((a, b) => a - b);
    if (arr.length === 0) return { n: 0, p50: 0, p95: 0, p99: 0, max: 0 };
    const q = (p: number) => arr[Math.min(arr.length - 1, Math.floor(p * arr.length))];
    return { n: arr.length, p50: q(0.5), p95: q(0.95), p99: q(0.99), max: arr[arr.length - 1] };
  }

  actions(): string[] {
    return [...this.samples.keys()].sort();
  }

  totalRequests(): number {
    return this.ok + this.errors;
  }
}

const rec = new Recorder();

async function timed<T>(action: string, fn: () => Promise<T>): Promise<T | undefined> {
  const t0 = performance.now();
  try {
    const r = await fn();
    rec.record(action, performance.now() - t0);
    rec.ok++;
    return r;
  } catch {
    rec.record(action, performance.now() - t0);
    rec.errors++;
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// The scripted user session
// ---------------------------------------------------------------------------

function rand([lo, hi]: [number, number]): number {
  return lo + Math.random() * (hi - lo);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function runSession(client: BenchClient, stopAt: number): Promise<void> {
  // 1. Page-load bundle (browser fires these together on load).
  const [listRes] = await Promise.all([
    timed("entries.list", () => client.entries.list.query({ limit: S.listLimit })),
    timed("subscriptions.list", () => client.subscriptions.list.query({ limit: 100 })),
    timed("tags.list", () => client.tags.list.query()),
    timed("entries.count(all)", () => client.entries.count.query({})),
    timed("entries.count(saved)", () => client.entries.count.query({ type: "saved" })),
    timed("entries.count(starred)", () => client.entries.count.query({ starredOnly: true })),
  ]);

  let items = (listRes as { items?: { id: string }[] } | undefined)?.items ?? [];
  let cursor = (listRes as { nextCursor?: string } | undefined)?.nextCursor;

  // 2. Scroll to load more pages.
  for (let p = 0; p < S.scrollPages && cursor && Date.now() < stopAt; p++) {
    await sleep(rand(S.thinkMs));
    const more = await timed("entries.list(scroll)", () =>
      client.entries.list.query({ limit: S.listLimit, cursor })
    );
    const moreItems = (more as { items?: { id: string }[] } | undefined)?.items ?? [];
    items = items.concat(moreItems);
    cursor = (more as { nextCursor?: string } | undefined)?.nextCursor;
  }

  const pool = items.map((i) => i.id);
  let poolIdx = 0;
  const nextId = (): string | undefined => (poolIdx < pool.length ? pool[poolIdx++] : undefined);

  // 3. Browse loop: open articles (get + markRead), occasional star.
  for (let a = 0; a < S.articlesOpened && Date.now() < stopAt; a++) {
    const id = nextId();
    if (!id) break;
    await sleep(rand(S.thinkMs));
    await timed("entries.get", () => client.entries.get.query({ id }));
    await timed("entries.markRead(1)", () =>
      client.entries.markRead.mutate({ entries: [{ id }], read: true })
    );
    if (Math.random() < S.starProbability) {
      await timed("entries.setStarred", () =>
        client.entries.setStarred.mutate({ id, starred: true })
      );
    }
  }

  // 4. Occasional batch mark-read.
  if (Math.random() < S.batchMarkReadProbability && Date.now() < stopAt) {
    const batch = pool.slice(poolIdx, poolIdx + S.batchMarkReadSize).map((id) => ({ id }));
    if (batch.length) {
      await timed(`entries.markRead(${batch.length})`, () =>
        client.entries.markRead.mutate({ entries: batch, read: true })
      );
    }
  }

  // 5. Rare mark-all-read.
  if (Math.random() < S.markAllReadProbability && Date.now() < stopAt) {
    await timed("entries.markAllRead", () => client.entries.markAllRead.mutate({}));
  }
}

/** One VU: loops sessions until the stage deadline. */
async function runVu(session: SessionInfo, stopAt: number): Promise<void> {
  const client = makeClient(BASE_URL, session.sessionToken);
  const closeSse = S.holdSse ? openSse(BASE_URL, session.sessionToken) : () => {};
  try {
    while (Date.now() < stopAt) {
      await runSession(client, stopAt);
      if (Date.now() >= stopAt) break;
      await sleep(rand(S.betweenSessionsMs));
    }
  } finally {
    closeSse();
  }
}

// ---------------------------------------------------------------------------
// Server metrics scrape (Prometheus text format)
// ---------------------------------------------------------------------------

interface ServerSnapshot {
  /** Peak connections in the pg pool observed during the stage. */
  peakPoolTotal?: number;
  /** Peak queued (waiting-for-connection) requests during the stage. */
  peakPoolWaiting?: number;
  /** Peak active SSE connections during the stage. */
  peakSseActive?: number;
  /** Server-side mean latency (ms) over the stage, from the tRPC histogram. */
  serverListMeanMs?: number;
  serverMarkReadMeanMs?: number;
}

async function fetchMetrics(): Promise<string | undefined> {
  if (!METRICS_URL) return undefined;
  try {
    const res = await fetch(METRICS_URL, { signal: AbortSignal.timeout(5000) });
    return await res.text();
  } catch {
    return undefined;
  }
}

function gauge(text: string, name: string): number | undefined {
  const m = text.match(new RegExp(`^${name}(?:\\{[^}]*\\})?\\s+([0-9.eE+-]+)`, "m"));
  return m ? Number(m[1]) : undefined;
}

/** Sum + count for a tRPC procedure's duration histogram (seconds). */
function trpcHist(text: string, procedure: string): { sum: number; count: number } {
  const sumRe = new RegExp(
    `^trpc_procedure_duration_seconds_sum\\{[^}]*procedure="${procedure}"[^}]*\\}\\s+([0-9.eE+-]+)`,
    "m"
  );
  const cntRe = new RegExp(
    `^trpc_procedure_duration_seconds_count\\{[^}]*procedure="${procedure}"[^}]*\\}\\s+([0-9.eE+-]+)`,
    "m"
  );
  const sum = text.match(sumRe);
  const cnt = text.match(cntRe);
  return { sum: sum ? Number(sum[1]) : 0, count: cnt ? Number(cnt[1]) : 0 };
}

/**
 * Samples pool/SSE gauges every `intervalMs` until `stopAt`, tracking peaks.
 * Runs concurrently with a stage's VUs so it captures live saturation.
 */
async function sampleGaugesDuring(
  stopAt: number,
  intervalMs: number
): Promise<Pick<ServerSnapshot, "peakPoolTotal" | "peakPoolWaiting" | "peakSseActive">> {
  const peak = { peakPoolTotal: 0, peakPoolWaiting: 0, peakSseActive: 0 };
  if (!METRICS_URL) return peak;
  while (Date.now() < stopAt) {
    const text = await fetchMetrics();
    if (text) {
      peak.peakPoolTotal = Math.max(
        peak.peakPoolTotal,
        gauge(text, "db_pool_total_connections") ?? 0
      );
      peak.peakPoolWaiting = Math.max(
        peak.peakPoolWaiting,
        gauge(text, "db_pool_waiting_requests") ?? 0
      );
      peak.peakSseActive = Math.max(peak.peakSseActive, gauge(text, "sse_connections_active") ?? 0);
    }
    await sleep(intervalMs);
  }
  return peak;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

interface StageResult {
  vus: number;
  durationS: number;
  totalRequests: number;
  rps: number;
  errorRate: number;
  listP95: number;
  listP50: number;
  server: ServerSnapshot;
  pass: boolean;
  limiter: string;
}

function loadSessions(): SessionInfo[] {
  const path = join(__dirname, "sessions.json");
  const data = JSON.parse(readFileSync(path, "utf8")) as {
    users: { userId: string; sessionToken: string }[];
  };
  if (!data.users?.length) throw new Error("sessions.json has no users — run seed-bench.ts first");
  return data.users;
}

async function runStage(vus: number, sessions: SessionInfo[]): Promise<StageResult> {
  rec.reset();
  const stopAt = Date.now() + STAGE_SECONDS * 1000;

  // Snapshot server-side histograms before the stage to compute per-stage means.
  const before = await fetchMetrics();
  const listBefore = before ? trpcHist(before, "entries.list") : { sum: 0, count: 0 };
  const mrBefore = before ? trpcHist(before, "entries.markRead") : { sum: 0, count: 0 };

  const vuPromises: Promise<void>[] = [];
  for (let i = 0; i < vus; i++) {
    // Distinct user per VU where possible; wrap around if fewer sessions.
    vuPromises.push(runVu(sessions[i % sessions.length], stopAt));
  }
  const gaugesPromise = sampleGaugesDuring(stopAt, 2000);
  await Promise.all(vuPromises);
  const peaks = await gaugesPromise;

  // Server-side mean latency over the stage (histogram delta).
  const after = await fetchMetrics();
  const listAfter = after ? trpcHist(after, "entries.list") : { sum: 0, count: 0 };
  const mrAfter = after ? trpcHist(after, "entries.markRead") : { sum: 0, count: 0 };
  const meanMs = (a: { sum: number; count: number }, b: { sum: number; count: number }) => {
    const dc = a.count - b.count;
    return dc > 0 ? ((a.sum - b.sum) / dc) * 1000 : undefined;
  };
  const server: ServerSnapshot = {
    ...peaks,
    serverListMeanMs: meanMs(listAfter, listBefore),
    serverMarkReadMeanMs: meanMs(mrAfter, mrBefore),
  };

  const listStats = rec.stats("entries.list");
  const total = rec.totalRequests();
  const errorRate = total > 0 ? rec.errors / total : 0;

  // Server-side-primary gate (see config SLO note).
  const serverListMean = server.serverListMeanMs ?? 0;
  const poolWaiting = server.peakPoolWaiting ?? 0;
  const serverSaturated =
    poolWaiting > SLO.maxPoolWaiting ||
    (METRICS_URL !== "" && serverListMean > SLO.serverListMeanMs);
  const pass = total > 0 && errorRate <= SLO.maxErrorRate && !serverSaturated;
  // Diagnose the limiter for the summary.
  const clientHot = listStats.p95 > SLO.clientListP95Ms;
  const limiter = !pass
    ? poolWaiting > SLO.maxPoolWaiting
      ? "DB pool saturated (queries queued for a connection)"
      : serverListMean > SLO.serverListMeanMs
        ? "server CPU/latency (server-side list latency climbed)"
        : errorRate > SLO.maxErrorRate
          ? "errors"
          : "unknown"
    : clientHot
      ? "generator-bound (client p95 high but server still flat)"
      : "";

  // Per-action table.
  console.log(`\n===== STAGE: ${vus} VUs (${STAGE_SECONDS}s) =====`);
  console.log(
    `${"action".padEnd(26)} ${"n".padStart(7)} ${"p50".padStart(8)} ${"p95".padStart(8)} ${"p99".padStart(8)} ${"max".padStart(8)}`
  );
  for (const action of rec.actions()) {
    const s = rec.stats(action);
    console.log(
      `${action.padEnd(26)} ${String(s.n).padStart(7)} ${s.p50.toFixed(0).padStart(8)} ` +
        `${s.p95.toFixed(0).padStart(8)} ${s.p99.toFixed(0).padStart(8)} ${s.max.toFixed(0).padStart(8)}`
    );
  }
  const rps = total / STAGE_SECONDS;
  console.log(
    `\n  requests=${total} rps=${rps.toFixed(1)} errors=${rec.errors} (${(errorRate * 100).toFixed(2)}%) ` +
      `list.p95=${listStats.p95.toFixed(0)}ms`
  );
  if (METRICS_URL) {
    console.log(
      `  server: peakPool=${server.peakPoolTotal ?? "?"} peakWaiting=${server.peakPoolWaiting ?? "?"} ` +
        `peakSSE=${server.peakSseActive ?? "?"} | serverside list.mean=${server.serverListMeanMs?.toFixed(1) ?? "?"}ms ` +
        `markRead.mean=${server.serverMarkReadMeanMs?.toFixed(1) ?? "?"}ms`
    );
  }
  console.log(
    `  SLO: ${pass ? "PASS ✅" : "FAIL ❌"} ` +
      `(serverList.mean<=${SLO.serverListMeanMs}ms, poolWaiting<=${SLO.maxPoolWaiting}, err<=${SLO.maxErrorRate * 100}%)` +
      (limiter ? `  → ${limiter}` : "")
  );

  return {
    vus,
    durationS: STAGE_SECONDS,
    totalRequests: total,
    rps,
    errorRate,
    listP95: listStats.p95,
    listP50: listStats.p50,
    server,
    pass,
    limiter,
  };
}

async function main() {
  const sessions = loadSessions();
  console.log(`Load test → ${BASE_URL}`);
  console.log(`Sessions available: ${sessions.length}`);
  console.log(
    `Stages (VUs): ${STAGES.join(", ")}  |  ${STAGE_SECONDS}s each  |  SSE hold: ${S.holdSse}`
  );
  if (METRICS_URL) console.log(`Server metrics: ${METRICS_URL}`);

  // Warmup: run a little traffic to warm the JIT + pg pool so stage 1 isn't
  // penalised by cold-start latency. Discarded (the first real stage resets rec).
  const warmupS = Number(process.env.WARMUP_SECONDS ?? 8);
  if (warmupS > 0) {
    console.log(`\nWarming up for ${warmupS}s…`);
    const stopAt = Date.now() + warmupS * 1000;
    const n = Math.min(STAGES[0], sessions.length);
    await Promise.all(
      Array.from({ length: n }, (_, i) => runVu(sessions[i % sessions.length], stopAt))
    );
  }

  const results: StageResult[] = [];
  let knee = 0;
  for (const vus of STAGES) {
    const r = await runStage(vus, sessions);
    results.push(r);
    if (r.pass) knee = vus;
    else {
      console.log(
        `\n>>> SLO breached at ${vus} VUs (${r.limiter}) — stopping ramp. Knee = ${knee} concurrent VUs.`
      );
      break;
    }
  }
  const lastStage = results[results.length - 1];

  const frac = workload.translation.peakConcurrentFraction;
  const registeredCeiling = knee > 0 ? Math.round(knee / frac) : 0;

  console.log(`\n================ CAPACITY SUMMARY ================`);
  console.log(`Sustainable concurrent active users (knee): ${knee}`);
  if (lastStage && !lastStage.pass) {
    console.log(`Limiter at first failing stage (${lastStage.vus} VUs): ${lastStage.limiter}`);
    if (lastStage.limiter.startsWith("generator-bound")) {
      console.log(
        `  ⚠ The SERVER still had headroom here (pool never queued, server latency flat).`
      );
      console.log(
        `    The single-process generator capped the run — the real server ceiling is HIGHER.`
      );
      console.log(`    Use more generator processes / a second box to push further.`);
    }
  } else if (knee === STAGES[STAGES.length - 1]) {
    console.log(`Ramp completed without breaching SLO — true knee is ≥ ${knee} (raise STAGES).`);
  }
  console.log(`Peak-concurrent fraction (from prod): ${(frac * 100).toFixed(1)}%`);
  console.log(`=> Registered-user ceiling ≈ ${registeredCeiling.toLocaleString()}`);
  console.log(`   (registered = concurrent / peakConcurrentFraction)`);

  if (RESULT_LABEL) {
    const out = join(__dirname, `results-${RESULT_LABEL}.json`);
    writeFileSync(
      out,
      JSON.stringify(
        { label: RESULT_LABEL, baseUrl: BASE_URL, knee, registeredCeiling, frac, stages: results },
        null,
        2
      )
    );
    console.log(`\nWrote ${out}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

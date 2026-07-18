/**
 * Anonymous-page load test — the HN-flood shape: unauthenticated visitors
 * hitting SSR pages (landing / demo / login / register). These pages don't touch
 * Postgres or SSE, but the root layout reads cookies()/headers() for the
 * per-request CSP nonce, so each one is a full React server-render (dynamic, not
 * prerendered). This measures how many such renders the app serves per second
 * and where latency degrades — i.e. whether a CDN in front of these HTML pages
 * would meaningfully offload the app.
 *
 * No think time (max throughput per VU). Sweeps concurrency.
 *
 *   BASE_URL=http://127.0.0.1:39547 METRICS_URL=http://127.0.0.1:9091/metrics \
 *     PATHS=/demo,/login,/register,/ CONCURRENCIES=10,25,50,100 DURATION_S=15 \
 *     npx tsx bench/anon-pages.ts
 */

import { Agent, fetch as undiciFetch } from "undici";

const BASE_URL = process.env.BASE_URL ?? "http://127.0.0.1:39547";
const METRICS_URL = process.env.METRICS_URL ?? "";
const PATHS = (process.env.PATHS ?? "/demo,/login,/register,/").split(",").map((s) => s.trim());
const CONCURRENCIES = (process.env.CONCURRENCIES ?? "10,25,50,100,200")
  .split(",")
  .map((s) => Number(s.trim()))
  .filter((n) => n > 0);
const DURATION_S = Number(process.env.DURATION_S ?? 15);

const dispatcher = new Agent({ connections: 4096, pipelining: 1, keepAliveTimeout: 60_000 });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function pctl(arr: number[], p: number): number {
  if (!arr.length) return 0;
  const s = arr.slice().sort((a, b) => a - b);
  return s[Math.max(0, Math.ceil(p * s.length) - 1)];
}

async function metricText(): Promise<string> {
  if (!METRICS_URL) return "";
  try {
    return await (
      await undiciFetch(METRICS_URL, { signal: AbortSignal.timeout(4000), dispatcher })
    ).text();
  } catch {
    return "";
  }
}
/** Sum sum/count for http_request_duration_seconds over the benchmarked paths. */
function httpHist(text: string): { sum: number; count: number } {
  let sum = 0;
  let count = 0;
  for (const p of PATHS) {
    const esc = p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    for (const m of text.matchAll(
      new RegExp(
        `^http_request_duration_seconds_sum\\{[^}]*route="${esc}"[^}]*\\}\\s+([0-9.eE+-]+)`,
        "gm"
      )
    ))
      sum += Number(m[1]);
    for (const m of text.matchAll(
      new RegExp(
        `^http_request_duration_seconds_count\\{[^}]*route="${esc}"[^}]*\\}\\s+([0-9.eE+-]+)`,
        "gm"
      )
    ))
      count += Number(m[1]);
  }
  return { sum, count };
}

async function stage(concurrency: number): Promise<void> {
  const latencies: number[] = [];
  let ok = 0;
  let err = 0;
  let bytes = 0;
  const before = httpHist(await metricText());
  const stopAt = Date.now() + DURATION_S * 1000;

  const vu = async () => {
    let i = 0;
    while (Date.now() < stopAt) {
      const path = PATHS[i++ % PATHS.length];
      const t0 = performance.now();
      try {
        const res = await undiciFetch(BASE_URL + path, {
          dispatcher,
          headers: { accept: "text/html" },
        });
        const body = await res.arrayBuffer();
        bytes += body.byteLength;
        latencies.push(performance.now() - t0);
        if (res.status >= 200 && res.status < 400) ok++;
        else err++;
      } catch {
        err++;
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, vu));

  const after = httpHist(await metricText());
  const dc = after.count - before.count;
  const serverMeanMs = dc > 0 ? ((after.sum - before.sum) / dc) * 1000 : undefined;
  const total = ok + err;
  const rps = total / DURATION_S;
  console.log(
    `  c=${String(concurrency).padStart(4)}  rps=${rps.toFixed(0).padStart(5)}  ` +
      `client p50=${pctl(latencies, 0.5).toFixed(0)}ms p95=${pctl(latencies, 0.95).toFixed(0)}ms  ` +
      `server-render mean=${serverMeanMs?.toFixed(1) ?? "?"}ms  ` +
      `MB/s=${(bytes / 1e6 / DURATION_S).toFixed(1)}  errors=${err}`
  );
}

async function main() {
  console.log(
    `Anonymous-page load → ${BASE_URL}  paths=[${PATHS.join(", ")}]  ${DURATION_S}s/stage`
  );
  // brief warmup to compile the routes
  const warm = Date.now() + 5000;
  await Promise.all(
    Array.from({ length: 5 }, async () => {
      while (Date.now() < warm) {
        for (const p of PATHS)
          await undiciFetch(BASE_URL + p, { dispatcher })
            .then((r) => r.arrayBuffer())
            .catch(() => {});
      }
    })
  );
  await sleep(300);
  for (const c of CONCURRENCIES) await stage(c);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

/**
 * Benchmark for the native feed parser's N-API boundary cost (issue #1291).
 *
 * Usage: node native/feed-parser/bench/bench.mjs <feed files...>
 *   --json <path>   also write canonical parsed output per feed (parity diffs)
 *   --iters <n>     iterations per feed (default 20)
 *
 * Reports, per feed:
 *   - sync parse time (parseRss/parseAtom): core parse + string conversion,
 *     all on the calling thread — the worker/background-job path.
 *   - async end-to-end (parseRssAsync/parseAtomAsync): the request path.
 *   - async main-thread stall: the largest event-loop gap observed while the
 *     async parse runs. The Rust parse happens on the libuv pool; the only
 *     main-thread work is AsyncTask::resolve() converting Rust strings to V8
 *     strings, so this approximates the boundary conversion cost.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { performance } from "node:perf_hooks";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const parser = require("../index.js");

const args = process.argv.slice(2);
const files = [];
let jsonDir;
let iters = 20;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--json") jsonDir = args[++i];
  else if (args[i] === "--iters") iters = Number(args[++i]);
  else files.push(args[i]);
}
if (files.length === 0) {
  console.error("usage: node bench.mjs [--json dir] [--iters n] <feed files...>");
  process.exit(1);
}

/** Sorts object keys recursively so JSON output is canonical for diffing. */
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, canonicalize(value[k])])
    );
  }
  return value;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/** Runs fn() while sampling event-loop gaps; returns [result, maxGapMs]. */
async function withLoopStall(fn) {
  let last = performance.now();
  let maxGap = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    maxGap = Math.max(maxGap, now - last);
    last = now;
  }, 0);
  // Let the interval establish a baseline tick before starting.
  await new Promise((r) => setTimeout(r, 5));
  last = performance.now();
  const result = await fn();
  clearInterval(timer);
  return [result, maxGap];
}

const results = [];
for (const file of files) {
  const content = readFileSync(file, "utf8");
  const isAtom =
    /<feed[\s>]/.test(content.slice(0, 2000)) && !/<rss[\s>]/.test(content.slice(0, 2000));
  const syncParse = isAtom ? parser.parseAtom : parser.parseRss;
  const asyncParse = isAtom ? parser.parseAtomAsync : parser.parseRssAsync;

  // Warmup + parity snapshot.
  const parsed = syncParse(content);
  if (jsonDir) {
    writeFileSync(
      `${jsonDir}/${basename(file)}.json`,
      JSON.stringify(canonicalize(parsed), null, 1)
    );
  }

  const syncTimes = [];
  for (let i = 0; i < iters; i++) {
    const t0 = performance.now();
    syncParse(content);
    syncTimes.push(performance.now() - t0);
  }

  const asyncTimes = [];
  const stalls = [];
  for (let i = 0; i < iters; i++) {
    const t0 = performance.now();
    const [, stall] = await withLoopStall(() => asyncParse(content));
    asyncTimes.push(performance.now() - t0);
    stalls.push(stall);
  }

  results.push({
    feed: basename(file),
    kb: Math.round(content.length / 1024),
    syncMs: median(syncTimes),
    asyncMs: median(asyncTimes),
    stallMs: median(stalls),
  });
}

console.log(
  [
    "feed".padEnd(16),
    "size".padStart(8),
    "sync".padStart(9),
    "async e2e".padStart(10),
    "MT stall".padStart(9),
  ].join("  ")
);
for (const r of results) {
  console.log(
    [
      r.feed.padEnd(16),
      `${r.kb} KB`.padStart(8),
      `${r.syncMs.toFixed(2)}ms`.padStart(9),
      `${r.asyncMs.toFixed(2)}ms`.padStart(10),
      `${r.stallMs.toFixed(2)}ms`.padStart(9),
    ].join("  ")
  );
}

if (typeof parser.stringConversionStats === "function") {
  console.log("\nstring conversion stats:", parser.stringConversionStats());
}

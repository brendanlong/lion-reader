/**
 * GC stress test for external strings (issue #1291). Run with:
 *   node --expose-gc native/feed-parser/bench/stress-gc.mjs <feed files...>
 *
 * External strings wrap Rust-owned memory, so the failure class is
 * use-after-free (string content changing/corrupting after GC), not parse
 * bugs. This parses each feed 8x concurrently, checksums every string field,
 * forces GC repeatedly while retaining the results, and re-verifies the
 * checksums; then drops everything and reports memory before/after.
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const parser = require("../index.js");

if (typeof globalThis.gc !== "function") {
  console.error("run with --expose-gc");
  process.exit(1);
}

const files = process.argv.slice(2);
const CONCURRENCY = 8;

function checksumFeed(feed) {
  const hash = createHash("sha256");
  for (const entry of feed.entries) {
    for (const field of [entry.guid, entry.link, entry.title, entry.content, entry.summary]) {
      if (field !== undefined) hash.update(field);
    }
  }
  return hash.digest("hex");
}

function mem() {
  const m = process.memoryUsage();
  const mb = (n) => `${Math.round(n / 1048576)} MB`;
  return `rss=${mb(m.rss)} heap=${mb(m.heapUsed)} external=${mb(m.external)}`;
}

let results = [];
const expected = [];
for (const file of files) {
  const content = readFileSync(file, "utf8");
  const isAtom =
    /<feed[\s>]/.test(content.slice(0, 2000)) && !/<rss[\s>]/.test(content.slice(0, 2000));
  const parse = isAtom ? parser.parseAtomAsync : parser.parseRssAsync;
  const batch = await Promise.all(Array.from({ length: CONCURRENCY }, () => parse(content)));
  for (const feed of batch) {
    results.push(feed);
    expected.push(checksumFeed(feed));
  }
  console.log(`${file}: ${CONCURRENCY} concurrent parses done; ${mem()}`);
}

console.log(`retained ${results.length} parses; ${mem()}`);

// Churn the heap and force GC repeatedly while the results are retained; an
// early-freed external string would come back corrupted (or crash).
for (let round = 0; round < 5; round++) {
  let junk = [];
  for (let i = 0; i < 1000; i++) junk.push("x".repeat(10000) + i);
  junk = null;
  globalThis.gc();
}
console.log(`after 5 GC rounds (retained); ${mem()}`);

let mismatches = 0;
for (let i = 0; i < results.length; i++) {
  if (checksumFeed(results[i]) !== expected[i]) mismatches++;
}
console.log(
  mismatches === 0 ? "checksums stable across GC: OK" : `CHECKSUM MISMATCHES: ${mismatches}`
);

results = null;
globalThis.gc();
globalThis.gc();
// External-string finalizers can be deferred; give the loop a beat and GC again.
await new Promise((r) => setTimeout(r, 100));
globalThis.gc();
console.log(`after release + GC; ${mem()}`);

if (typeof parser.stringConversionStats === "function") {
  console.log("string conversion stats:", parser.stringConversionStats());
}
if (mismatches > 0) process.exit(1);

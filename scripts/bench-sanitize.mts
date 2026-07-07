/**
 * Benchmark for the entry-content sanitizer (`sanitizeEntryHtml`).
 *
 * Run with: pnpm tsx scripts/bench-sanitize.mts
 *
 * Measures the full pipeline (convertMathJaxChtmlToMathml + sanitize-html) plus
 * component costs, across representative document sizes, and compares against a
 * few candidate optimizations.
 */

import { readFileSync } from "node:fs";
import sanitizeHtml from "sanitize-html";
import { sanitizeEntryHtml } from "@/server/html/sanitize";
import { convertMathJaxChtmlToMathml } from "@/server/html/mathjax-chtml";

// ---------------------------------------------------------------------------
// Content generators — synthesize realistic article HTML at various sizes.
// ---------------------------------------------------------------------------

function makeParagraph(i: number): string {
  return (
    `<p class="body-text" id="p${i}">This is paragraph number ${i} with some ` +
    `<a href="https://example.com/article/${i}">an external link</a> and ` +
    `<strong>bold</strong>, <em>emphasized</em>, and <code>inline code</code> text. ` +
    `Here is <a href="/relative/${i}">a relative link</a> and an image ` +
    `<img src="https://cdn.example.com/img/${i}.jpg" alt="figure ${i}" width="800" height="600">.</p>`
  );
}

function makeArticle(paragraphs: number): string {
  const parts: string[] = ["<article><h1>Sample Article</h1>"];
  for (let i = 0; i < paragraphs; i++) {
    parts.push(makeParagraph(i));
    if (i % 10 === 0) {
      parts.push(
        `<blockquote><p>A quoted passage ${i}.</p></blockquote>` +
          `<pre><code>const x = ${i};\nfunction f() { return x * 2; }</code></pre>` +
          `<ul><li>item ${i}.1</li><li>item ${i}.2</li><li>item ${i}.3</li></ul>`
      );
    }
  }
  parts.push("</article>");
  return parts.join("\n");
}

const mathFixtures = JSON.parse(
  readFileSync(new URL("../tests/unit/fixtures/mathjax-chtml-v3.json", import.meta.url), "utf8")
) as Record<string, string>;
const mathBlocks = Object.values(mathFixtures);

function makeMathArticle(paragraphs: number): string {
  const parts: string[] = ["<article><h1>Math Article</h1>"];
  for (let i = 0; i < paragraphs; i++) {
    parts.push(makeParagraph(i));
    parts.push(mathBlocks[i % mathBlocks.length]);
  }
  parts.push("</article>");
  return parts.join("\n");
}

const corpus: Record<string, string> = {
  small: makeArticle(10), // typical short post
  medium: makeArticle(150), // typical long-form article
  large: makeArticle(1200), // large article (~700KB territory)
  mathHeavy: makeMathArticle(80), // math-dense (LessWrong style)
};

// ---------------------------------------------------------------------------
// Timing helpers
// ---------------------------------------------------------------------------

function bench(name: string, fn: () => void, iterations: number): number {
  // Warmup
  for (let i = 0; i < Math.min(iterations, 20); i++) fn();
  if (globalThis.gc) globalThis.gc();
  const start = process.hrtime.bigint();
  for (let i = 0; i < iterations; i++) fn();
  const end = process.hrtime.bigint();
  const totalMs = Number(end - start) / 1e6;
  const perMs = totalMs / iterations;
  console.log(`  ${name.padEnd(42)} ${perMs.toFixed(3)} ms/op  (${iterations} iters)`);
  return perMs;
}

function memBench(name: string, fn: () => void, iterations: number): void {
  if (globalThis.gc) globalThis.gc();
  const before = process.memoryUsage().heapUsed;
  const sink: unknown[] = [];
  for (let i = 0; i < iterations; i++) sink.push(fn());
  const after = process.memoryUsage().heapUsed;
  const perOp = (after - before) / iterations;
  console.log(`  ${name.padEnd(42)} ${(perOp / 1024).toFixed(1)} KB/op retained (rough)`);
  void sink;
}

// ---------------------------------------------------------------------------
// Precompiled-options variant: build sanitize-html option-derived structures
// once. sanitize-html has no public API for this, but we can at least avoid
// re-merging defaults each call by passing a frozen options object (it still
// re-derives internal maps). We measure the ceiling by a raw parse+serialize.
// ---------------------------------------------------------------------------

import { Parser } from "htmlparser2";

function parseOnlyCost(html: string): void {
  let count = 0;
  const parser = new Parser({
    onopentag() {
      count++;
    },
    ontext() {
      count++;
    },
    onclosetag() {
      count++;
    },
  });
  parser.write(html);
  parser.end();
  if (count < 0) throw new Error("unreachable");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const ITERS: Record<string, number> = {
  small: 2000,
  medium: 300,
  large: 40,
  mathHeavy: 200,
};

console.log("=== Sizes ===");
for (const [name, html] of Object.entries(corpus)) {
  console.log(`  ${name.padEnd(12)} ${(Buffer.byteLength(html) / 1024).toFixed(1)} KB`);
}

console.log("\n=== Full pipeline: sanitizeEntryHtml ===");
for (const [name, html] of Object.entries(corpus)) {
  bench(`sanitizeEntryHtml[${name}]`, () => sanitizeEntryHtml(html), ITERS[name]);
}

console.log("\n=== Component breakdown ===");
for (const [name, html] of Object.entries(corpus)) {
  const iters = ITERS[name];
  console.log(` -- ${name} --`);
  bench(`mathjax-precheck+convert`, () => convertMathJaxChtmlToMathml(html), iters);
  bench(`sanitize-html only`, () => sanitizeHtml(html), iters);
  bench(`parse-only (htmlparser2)`, () => parseOnlyCost(html), iters);
}

console.log("\n=== Per-call fixed overhead (tiny input) ===");
// Isolates option-processing setup cost from parse/serialize.
bench(`sanitizeHtml('<p>x</p>')`, () => sanitizeHtml("<p>x</p>"), 20000);
bench(`sanitizeEntryHtml('<p>x</p>')`, () => sanitizeEntryHtml("<p>x</p>"), 20000);

console.log("\n=== Rough retained memory ===");
for (const [name, html] of Object.entries(corpus)) {
  memBench(`sanitizeEntryHtml[${name}]`, () => sanitizeEntryHtml(html), Math.min(ITERS[name], 50));
}

console.log("\nDone.");

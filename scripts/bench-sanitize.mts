/**
 * Benchmark for the entry-content sanitizer (`sanitizeEntryHtml`).
 *
 * Run with: pnpm tsx scripts/bench-sanitize.mts
 *
 * Measures the full native pipeline (MathJax CHTML→MathML + inline-SVG +
 * lol_html allow-list pass, one N-API call) across representative document
 * sizes, both synchronously and via the async libuv-thread-pool form.
 */

import { readFileSync } from "node:fs";
import { sanitizeEntryHtml, sanitizeEntryHtmlAsync } from "@/server/html/sanitize";

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
  for (let i = 0; i < Math.min(iterations, 20); i++) fn();
  if (globalThis.gc) globalThis.gc();
  const start = process.hrtime.bigint();
  for (let i = 0; i < iterations; i++) fn();
  const end = process.hrtime.bigint();
  const perMs = Number(end - start) / 1e6 / iterations;
  console.log(`  ${name.padEnd(42)} ${perMs.toFixed(3)} ms/op  (${iterations} iters)`);
  return perMs;
}

async function benchAsync(name: string, fn: () => Promise<void>, iterations: number) {
  for (let i = 0; i < Math.min(iterations, 20); i++) await fn();
  const start = process.hrtime.bigint();
  for (let i = 0; i < iterations; i++) await fn();
  const end = process.hrtime.bigint();
  const perMs = Number(end - start) / 1e6 / iterations;
  console.log(`  ${name.padEnd(42)} ${perMs.toFixed(3)} ms/op  (${iterations} iters)`);
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

console.log("\n=== Full pipeline: sanitizeEntryHtml (sync) ===");
for (const [name, html] of Object.entries(corpus)) {
  bench(`sanitizeEntryHtml[${name}]`, () => sanitizeEntryHtml(html), ITERS[name]);
}

console.log("\n=== Full pipeline: sanitizeEntryHtmlAsync (libuv pool) ===");
for (const [name, html] of Object.entries(corpus)) {
  await benchAsync(
    `sanitizeEntryHtmlAsync[${name}]`,
    async () => {
      await sanitizeEntryHtmlAsync(html);
    },
    ITERS[name]
  );
}

console.log("\n=== Per-call fixed overhead (tiny input) ===");
bench(`sanitizeEntryHtml('<p>x</p>')`, () => sanitizeEntryHtml("<p>x</p>"), 20000);

console.log("\nDone.");

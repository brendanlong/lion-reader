/**
 * Benchmark for the write-time URL pass (`absolutizeUrls` in the native
 * sanitizer), with and without moving inlined images out to storage.
 *
 * Run with: pnpm bench:absolutize
 *
 * Each document runs through the pass twice: absolutizing only (no image URL
 * prefix, as when storage isn't configured) and absolutizing while extracting
 * images. Documents without inlined images show what extraction costs every
 * entry; the others show what decoding and hashing the images costs, and how
 * much it saves the sanitizer, which runs on every read of the stored HTML.
 */

import { randomBytes } from "node:crypto";
import { absolutizeUrls, sanitizeEntryHtml } from "@lion-reader/sanitizer";

const BASE_URL = "https://example.com/articles/post";
const IMAGE_URL_PREFIX =
  "https://lion-reader.fly.storage.tigris.dev/uploads/0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b/0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c/";

/** A lazy-loading placeholder: too short to be worth moving. */
const PLACEHOLDER_GIF =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

function pngDataUri(bytes: number): string {
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    randomBytes(bytes),
  ]);
  return `data:image/png;base64,${png.toString("base64")}`;
}

function makeArticle(paragraphs: number, imageSrc: (i: number) => string): string {
  const parts: string[] = ["<article><h1>Sample Article</h1>"];
  for (let i = 0; i < paragraphs; i++) {
    parts.push(
      `<p>Paragraph ${i} with <a href="/relative/${i}">a relative link</a>, ` +
        `<a href="https://other.example.com/${i}">an absolute one</a> and an image ` +
        `<img src="${imageSrc(i)}" alt="figure ${i}" width="800" height="600">.</p>`
    );
  }
  parts.push("</article>");
  return parts.join("\n");
}

const remoteImage = (i: number): string => `https://cdn.example.com/img/${i}.jpg`;

const corpus: Record<string, { html: string; iterations: number }> = {
  medium: { html: makeArticle(150, remoteImage), iterations: 300 },
  large: { html: makeArticle(1200, remoteImage), iterations: 40 },
  // Lazy-loading feeds put a placeholder data: URI on every image.
  mediumPlaceholders: { html: makeArticle(150, () => PLACEHOLDER_GIF), iterations: 300 },
  // A .docx or an agent's upload: a few large images inline.
  fourImages1MB: {
    html: makeArticle(150, (i) => (i % 40 === 0 ? pngDataUri(256 * 1024) : remoteImage(i))),
    iterations: 40,
  },
  manySmallImages: { html: makeArticle(150, () => pngDataUri(4 * 1024)), iterations: 100 },
};

function bench(name: string, fn: () => void, iterations: number): number {
  for (let i = 0; i < Math.min(iterations, 20); i++) fn();
  const start = process.hrtime.bigint();
  for (let i = 0; i < iterations; i++) fn();
  const perMs = Number(process.hrtime.bigint() - start) / 1e6 / iterations;
  console.log(`  ${name.padEnd(44)} ${perMs.toFixed(3)} ms/op  (${iterations} iters)`);
  return perMs;
}

console.log("=== Sizes ===");
for (const [name, { html }] of Object.entries(corpus)) {
  console.log(`  ${name.padEnd(20)} ${(Buffer.byteLength(html) / 1024).toFixed(1)} KB`);
}

console.log("\n=== absolutizeUrls: absolutize only vs. also extracting images ===");
for (const [name, { html, iterations }] of Object.entries(corpus)) {
  const plain = bench(`${name} absolutize`, () => absolutizeUrls(html, BASE_URL), iterations);
  const extracting = bench(
    `${name} absolutize + extract`,
    () => absolutizeUrls(html, BASE_URL, { imageUrlPrefix: IMAGE_URL_PREFIX }),
    iterations
  );
  const stored = absolutizeUrls(html, BASE_URL, { imageUrlPrefix: IMAGE_URL_PREFIX });
  console.log(
    `  ${"".padEnd(44)} ${((extracting / plain - 1) * 100).toFixed(1)}% slower, ${stored.images.length} images moved`
  );
  if (stored.images.length > 0) {
    const inline = absolutizeUrls(html, BASE_URL).html;
    bench(`${name} sanitize on read, inline`, () => sanitizeEntryHtml(inline), iterations);
    bench(`${name} sanitize on read, moved`, () => sanitizeEntryHtml(stored.html), iterations);
  }
  console.log();
}

console.log("Done.");

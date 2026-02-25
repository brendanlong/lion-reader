#!/usr/bin/env node

/**
 * Test streaming compression by making requests with various Accept-Encoding
 * headers and measuring raw (on-the-wire) chunk sizes and timing.
 *
 * Uses node:http/node:https directly to avoid automatic decompression
 * that fetch() performs, so reported sizes reflect actual transfer size.
 *
 * Usage:
 *   node scripts/test-streaming-compression.mjs --url https://lionreader.com/all --session <token>
 *   node scripts/test-streaming-compression.mjs --url http://localhost:3000/all --session <token>
 */

import http from "node:http";
import https from "node:https";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    url: { type: "string", default: "https://lionreader.com/all" },
    session: { type: "string", short: "s" },
    encodings: {
      type: "string",
      default: "identity/gzip/br/zstd/gzip, br, zstd",
    },
  },
});

if (!values.session) {
  console.error(
    "Usage: node scripts/test-streaming-compression.mjs --session <token> [--url <url>]"
  );
  console.error("");
  console.error("Options:");
  console.error("  --session, -s   Session token to send in cookie header (required)");
  console.error("  --url           URL to request (default: https://lionreader.com/all)");
  console.error(
    '  --encodings     Slash-separated Accept-Encoding values to test (default: "identity/gzip/br/zstd/gzip, br, zstd")'
  );
  process.exit(1);
}

const targetUrl = values.url;
const sessionToken = values.session;
const encodings = values.encodings.split("/").map((e) => e.trim());

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatMs(ms) {
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

/**
 * Make an HTTP(S) request and collect raw (compressed) chunks with timing.
 * Follows redirects manually to preserve Accept-Encoding header.
 */
function makeRequest(url, encoding, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    if (maxRedirects <= 0) {
      return reject(new Error("Too many redirects"));
    }

    const parsed = new URL(url);
    const transport = parsed.protocol === "https:" ? https : http;

    const startTime = performance.now();
    let firstByteTime = null;
    const chunks = [];

    const req = transport.request(
      parsed,
      {
        method: "GET",
        headers: {
          "Accept-Encoding": encoding,
          Cookie: `session=${sessionToken}`,
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "User-Agent": "streaming-compression-test/1.0",
        },
      },
      (res) => {
        // Follow redirects
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          const redirectUrl = new URL(res.headers.location, url).toString();
          res.resume(); // drain the response
          return resolve(makeRequest(redirectUrl, encoding, maxRedirects - 1));
        }

        const status = res.statusCode;
        const contentEncoding = res.headers["content-encoding"] || "none";
        const contentLength = res.headers["content-length"] || null;
        const transferEncoding = res.headers["transfer-encoding"] || null;

        res.on("data", (chunk) => {
          const now = performance.now();
          if (firstByteTime === null) {
            firstByteTime = now;
          }
          chunks.push({
            size: chunk.length,
            elapsed: now - startTime,
            sinceLastChunk:
              chunks.length > 0 ? now - startTime - chunks[chunks.length - 1].elapsed : 0,
          });
        });

        res.on("end", () => {
          const endTime = performance.now();
          const totalBytes = chunks.reduce((sum, c) => sum + c.size, 0);

          resolve({
            encoding,
            status,
            contentEncoding,
            contentLength,
            transferEncoding,
            totalBytes,
            totalTime: endTime - startTime,
            ttfb: firstByteTime ? firstByteTime - startTime : null,
            chunkCount: chunks.length,
            chunks,
          });
        });

        res.on("error", reject);
      }
    );

    req.on("error", reject);
    req.end();
  });
}

function printResult(result) {
  console.log("─".repeat(80));
  console.log(`Accept-Encoding: ${result.encoding}`);
  console.log(`  Status:            ${result.status}`);
  console.log(`  Content-Encoding:  ${result.contentEncoding}`);
  if (result.transferEncoding) {
    console.log(`  Transfer-Encoding: ${result.transferEncoding}`);
  }
  if (result.contentLength) {
    console.log(`  Content-Length:     ${result.contentLength}`);
  }

  if (result.error) {
    console.log(`  Error: ${result.error}`);
    return;
  }

  console.log(`  Wire size:         ${formatBytes(result.totalBytes)} (raw compressed bytes)`);
  console.log(`  Total time:        ${formatMs(result.totalTime)}`);
  console.log(`  TTFB:              ${formatMs(result.ttfb)}`);
  console.log(`  Chunks:            ${result.chunkCount}`);
  console.log("");

  // Print chunk timeline
  if (result.chunks.length > 0) {
    console.log("  Chunk timeline:");
    console.log(
      "  " + "  #".padEnd(6) + "Size".padEnd(12) + "Elapsed".padEnd(12) + "Gap".padEnd(12) + "Bar"
    );

    const maxSize = Math.max(...result.chunks.map((c) => c.size));

    for (let i = 0; i < result.chunks.length; i++) {
      const chunk = result.chunks[i];
      const barLen = Math.max(1, Math.round((chunk.size / maxSize) * 40));
      const bar = "█".repeat(barLen);

      console.log(
        "  " +
          `${i + 1}`.padStart(4).padEnd(6) +
          formatBytes(chunk.size).padEnd(12) +
          formatMs(chunk.elapsed).padEnd(12) +
          (i === 0 ? "-" : formatMs(chunk.sinceLastChunk)).padEnd(12) +
          bar
      );
    }
  }

  console.log("");
}

async function main() {
  console.log(`Testing streaming compression for: ${targetUrl}`);
  console.log(`Encodings to test: ${encodings.join(", ")}`);
  console.log("Note: sizes shown are raw wire bytes (compressed), not decompressed size.");
  console.log("");

  const results = [];

  for (const encoding of encodings) {
    try {
      const result = await makeRequest(targetUrl, encoding);
      results.push(result);
      printResult(result);
    } catch (err) {
      console.log("─".repeat(80));
      console.log(`Accept-Encoding: ${encoding}`);
      console.log(`  Error: ${err.message}`);
      console.log("");
    }
  }

  // Print summary table
  if (results.length > 1) {
    console.log("═".repeat(80));
    console.log("SUMMARY");
    console.log("═".repeat(80));
    console.log(
      "  " +
        "Encoding".padEnd(22) +
        "Resp Encoding".padEnd(16) +
        "Wire Size".padEnd(18) +
        "TTFB".padEnd(10) +
        "Total".padEnd(10) +
        "Chunks"
    );
    console.log("  " + "─".repeat(76));

    const identityResult = results.find((r) => r.encoding === "identity" && r.totalBytes);

    for (const r of results) {
      if (!r.totalBytes) continue;

      let sizeStr = formatBytes(r.totalBytes);
      if (identityResult && r !== identityResult) {
        const ratio = ((r.totalBytes / identityResult.totalBytes) * 100).toFixed(0);
        sizeStr += ` (${ratio}%)`;
      }

      console.log(
        "  " +
          r.encoding.padEnd(22) +
          r.contentEncoding.padEnd(16) +
          sizeStr.padEnd(18) +
          formatMs(r.ttfb).padEnd(10) +
          formatMs(r.totalTime).padEnd(10) +
          r.chunkCount
      );
    }
    console.log("");
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

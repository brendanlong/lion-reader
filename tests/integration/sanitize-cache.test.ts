/**
 * Integration tests for the Redis-backed sanitized-HTML cache.
 *
 * `entries.get` sanitizes up to four large content fields on every read, which
 * dominates that endpoint's latency. `sanitizeEntryHtmlCached` /
 * `warmSanitizedEntryHtml` move that cost off the read path by caching the
 * (deterministic) sanitizer output, content-addressed in Redis.
 *
 * Uses a real Redis via docker-compose.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash } from "crypto";
import Redis from "ioredis";
import {
  sanitizeEntryHtmlCached,
  warmSanitizedEntryHtml,
} from "../../src/server/html/sanitize-cache";
import { sanitizeEntryHtml, SANITIZER_VERSION } from "../../src/server/html/sanitize";

// Raw client for inspecting cache state independently of the code under test.
let redis: Redis;

beforeAll(() => {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    throw new Error("REDIS_URL must be set for integration tests");
  }
  redis = new Redis(redisUrl);
});

afterAll(async () => {
  await redis.quit();
});

function keyFor(html: string): string {
  return (
    `sanitize:v${SANITIZER_VERSION}:` + createHash("sha256").update(html, "utf8").digest("hex")
  );
}

// Unique content per test so cases don't share cache entries.
function uniqueHtml(): string {
  const nonce = createHash("sha256").update(`${process.hrtime.bigint()}`).digest("hex");
  return `<p onclick="evil()">hello <script>alert(1)</script><b>${nonce}</b></p>`;
}

describe("sanitizeEntryHtmlCached", () => {
  it("returns null for empty input without touching Redis", async () => {
    expect(await sanitizeEntryHtmlCached(null)).toBeNull();
    expect(await sanitizeEntryHtmlCached(undefined)).toBeNull();
    expect(await sanitizeEntryHtmlCached("")).toBeNull();
  });

  it("matches sanitizeEntryHtml output and strips dangerous markup", async () => {
    const html = uniqueHtml();
    const result = await sanitizeEntryHtmlCached(html);
    expect(result).toEqual(sanitizeEntryHtml(html));
    expect(result).not.toContain("<script>");
    expect(result).not.toContain("onclick");
  });

  it("populates the cache on first read (miss) and reads it back (hit)", async () => {
    const html = uniqueHtml();
    const key = keyFor(html);
    expect(await redis.exists(key)).toBe(0);

    const first = await sanitizeEntryHtmlCached(html);
    expect(await redis.exists(key)).toBe(1);
    expect(await redis.get(key)).toEqual(first);

    // Second call is served from the cache: poison the stored value and confirm
    // the cached (poisoned) value comes back rather than a fresh sanitize.
    await redis.set(key, "CACHED_SENTINEL");
    expect(await sanitizeEntryHtmlCached(html)).toBe("CACHED_SENTINEL");
  });

  it("sets a TTL on cached entries", async () => {
    const html = uniqueHtml();
    await sanitizeEntryHtmlCached(html);
    const ttl = await redis.ttl(keyFor(html));
    expect(ttl).toBeGreaterThan(0);
  });
});

describe("warmSanitizedEntryHtml", () => {
  it("pre-populates the cache so a later read is a hit", async () => {
    const html = uniqueHtml();
    const key = keyFor(html);
    expect(await redis.exists(key)).toBe(0);

    await warmSanitizedEntryHtml([html, null, undefined]);

    expect(await redis.get(key)).toEqual(sanitizeEntryHtml(html));

    // A subsequent cached read returns the warmed value without recomputing.
    await redis.set(key, "WARMED_SENTINEL");
    expect(await sanitizeEntryHtmlCached(html)).toBe("WARMED_SENTINEL");
  });

  it("is a no-op when given only empty values", async () => {
    await expect(warmSanitizedEntryHtml([null, undefined, ""])).resolves.toBeUndefined();
  });
});

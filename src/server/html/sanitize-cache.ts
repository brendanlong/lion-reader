/**
 * Redis-backed cache for sanitized entry HTML.
 *
 * `sanitizeEntryHtml` parses and re-serializes the full HTML body with
 * `sanitize-html`, which costs ~50ms per ~700KB on the read path (and runs on
 * up to four content fields per `entries.get`). The output is deterministic for
 * a given `(html, sanitizer-config)`, so we cache it instead of re-computing on
 * every read.
 *
 * The cache is **content-addressed**: the key is `sha256(html)` plus
 * `SANITIZER_VERSION`. This deduplicates identical content across entries/users
 * automatically, needs no invalidation (changing the allow-list bumps
 * `SANITIZER_VERSION`, which changes every key; old entries expire via TTL), and
 * sidesteps the fact that `entries.content_hash` covers title+raw-content rather
 * than the per-field absolutized/cleaned strings we actually sanitize.
 *
 * Redis is optional. Without it (`REDIS_URL` unset, e.g. some dev/test setups)
 * every helper degrades to a direct `sanitizeEntryHtml` call.
 */

import { createHash } from "crypto";
import { getRedisClient } from "@/server/redis";
import { logger } from "@/lib/logger";
import { sanitizeEntryHtml, SANITIZER_VERSION } from "./sanitize";

const KEY_PREFIX = `sanitize:v${SANITIZER_VERSION}:`;

/**
 * TTL for cached sanitized HTML. Content-addressed entries are immutable, so
 * this only bounds memory: entries nobody reads expire, actively-read ones are
 * refreshed on the next cache miss after expiry. Overridable via env for ops.
 */
const TTL_SECONDS = Number(process.env.SANITIZE_CACHE_TTL_SECONDS) || 7 * 24 * 60 * 60;

function cacheKey(html: string): string {
  return KEY_PREFIX + createHash("sha256").update(html, "utf8").digest("hex");
}

/**
 * Sanitizes entry HTML, returning a cached result when available.
 *
 * Mirrors `sanitizeEntryHtml`'s contract: returns `null` for null/empty input
 * so callers can pass nullable content fields through unchanged.
 */
export async function sanitizeEntryHtmlCached(
  html: string | null | undefined
): Promise<string | null> {
  if (!html) return null;

  const redis = getRedisClient();
  if (!redis) return sanitizeEntryHtml(html);

  const key = cacheKey(html);
  try {
    const cached = await redis.get(key);
    // "" is a valid sanitized value (content that sanitizes to empty), so only
    // a literal null means "not cached".
    if (cached !== null) return cached;
  } catch (err) {
    logger.warn("sanitize cache read failed; sanitizing directly", { err });
    return sanitizeEntryHtml(html);
  }

  const sanitized = sanitizeEntryHtml(html) ?? "";
  try {
    await redis.setex(key, TTL_SECONDS, sanitized);
  } catch (err) {
    logger.warn("sanitize cache write failed", { err });
  }
  return sanitized;
}

/**
 * Proactively sanitizes and caches HTML so later reads hit the cache.
 *
 * Intended for fire-and-forget use on write paths (feed worker, full-content
 * fetch) to move sanitization CPU off the user-facing read path. Safe to call
 * without Redis (no-op) and never throws — failures are logged and swallowed so
 * they can't disrupt entry processing.
 */
export async function warmSanitizedEntryHtml(
  htmls: Array<string | null | undefined>
): Promise<void> {
  const redis = getRedisClient();
  if (!redis) return;

  try {
    const pipeline = redis.pipeline();
    let queued = 0;
    for (const html of htmls) {
      if (!html) continue;
      const sanitized = sanitizeEntryHtml(html) ?? "";
      pipeline.setex(cacheKey(html), TTL_SECONDS, sanitized);
      queued++;
    }
    if (queued === 0) return;
    await pipeline.exec();
  } catch (err) {
    logger.warn("sanitize cache warm failed", { err });
  }
}

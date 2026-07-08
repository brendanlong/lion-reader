/**
 * Worker thread pool for CPU-intensive operations.
 *
 * Provides async wrappers around cleanContent and parseFeed that run the
 * actual work in a piscina worker thread, keeping the main event loop free
 * for handling API requests.
 *
 * - Lazy-initialised on first call (no threads spawned at import time)
 * - Graceful fallback to inline execution if the pool cannot be created
 *   (e.g. in test environments or unsupported runtimes)
 * - Uses niceIncrement so worker threads get lower OS scheduling priority
 *   than the main thread, ensuring fast API responses take precedence
 */

import { existsSync } from "fs";
import { resolve } from "path";
import { availableParallelism } from "os";
import Piscina from "piscina";

import { logger } from "@/lib/logger";
import { sanitizeEntryHtml, SANITIZER_VERSION } from "@/server/html/sanitize";
import {
  cleanedContentSchema,
  sanitizeEntryHtmlResultSchema,
  sanitizerVersionResultSchema,
  serializedParsedFeedSchema,
  deserializeParsedFeed,
} from "./types";
import type { CleanedContent, CleanContentOptions, ParsedFeed } from "./types";

/**
 * Bodies at or below this size are sanitized inline on the calling thread:
 * sanitize-html runs in well under a millisecond for them, so the fixed cost of
 * copying the string across the thread boundary (and scheduling a task) isn't
 * worth paying. Larger bodies (tens of ms of blocking) are offloaded so they
 * never stall UI-serving requests on the app-server event loop. ~10 KB.
 */
const SANITIZE_INLINE_MAX_CHARS = 10 * 1024;

// ---------------------------------------------------------------------------
// Pool singleton
// ---------------------------------------------------------------------------

let pool: Piscina | null = null;
let poolInitFailed = false;

function resolveWorkerPath(): { filename: string; execArgv?: string[] } {
  // Use process.cwd() for all path resolution — __dirname gets replaced by
  // Next.js webpack at compile time with a virtual path, breaking resolution.
  const cwd = process.cwd();

  const distPath = resolve(cwd, "dist/worker-thread.js");
  const srcPath = resolve(cwd, "src/server/worker-thread/worker.ts");

  // Production runs the compiled bundle (tsx isn't available). In dev we prefer
  // the TS source via the tsx loader over any `dist/worker-thread.js` left by a
  // prior `build:all`: the bundle now embeds the sanitizer allow-list, so a
  // stale one would sanitize offloaded bodies with an out-of-date
  // `SANITIZE_OPTIONS` while the main process stamps rows with the current
  // `SANITIZER_VERSION` — silently persisting mis-sanitized content that the
  // version-gated self-heal would never notice. Preferring src keeps the worker
  // in lockstep with the running code.
  if (process.env.NODE_ENV === "production") {
    if (existsSync(distPath)) {
      return { filename: distPath };
    }
    // Shouldn't happen in a real prod deploy; fall through to src as a backstop.
  }

  if (existsSync(srcPath)) {
    return { filename: srcPath, execArgv: ["--import", "tsx"] };
  }

  // No source tree (e.g. a production-style bundle run with NODE_ENV unset).
  return { filename: distPath };
}

function getPool(): Piscina | null {
  if (poolInitFailed) return null;
  if (pool) return pool;

  try {
    const { filename, execArgv } = resolveWorkerPath();

    const threadCount = process.env.WORKER_THREAD_POOL_SIZE
      ? parseInt(process.env.WORKER_THREAD_POOL_SIZE, 10)
      : Math.max(1, Math.min(4, Math.floor(availableParallelism() / 2)));

    pool = new Piscina({
      filename,
      execArgv,
      minThreads: 1,
      maxThreads: threadCount,
      idleTimeout: 60_000,
      // Lower OS scheduling priority for worker threads so the main event
      // loop (handling fast API requests) gets CPU preference under contention.
      // nice 10 ≈ 25% CPU share vs the main thread on a busy box.
      niceIncrement: 10,
    });

    logger.info("Worker thread pool initialised", {
      threads: `${1}-${threadCount}`,
      filename,
    });

    return pool;
  } catch (error) {
    poolInitFailed = true;
    logger.warn("Failed to initialise worker thread pool, falling back to inline execution", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public API — same signatures as the originals, but async
// ---------------------------------------------------------------------------

/**
 * Clean HTML content using Mozilla Readability (runs in a worker thread).
 *
 * Drop-in async replacement for the synchronous `cleanContent` from
 * `@/server/feed/content-cleaner`. Falls back to inline execution if
 * the worker pool is unavailable.
 */
export async function cleanContentInWorker(
  html: string,
  options?: CleanContentOptions,
  extra?: { sanitizeCleaned?: boolean }
): Promise<CleanedContent | null> {
  const p = getPool();
  if (!p) {
    const { cleanContent } = await import("@/server/feed/content-cleaner");
    const cleaned = cleanContent(html, options);
    if (!cleaned) return null;
    // Match the worker's fused-sanitize behaviour on the inline fallback path.
    return extra?.sanitizeCleaned
      ? { ...cleaned, contentSanitized: sanitizeEntryHtml(cleaned.content) }
      : cleaned;
  }

  const result = await p.run({
    type: "cleanContent",
    html,
    options,
    sanitizeCleaned: extra?.sanitizeCleaned,
  });
  if (result === null) return null;
  return cleanedContentSchema.parse(result);
}

/**
 * Sanitize entry-content HTML, offloading to a worker thread for large bodies
 * so the sanitize-html pass never blocks the main event loop on UI-serving
 * requests. Small bodies (≤ SANITIZE_INLINE_MAX_CHARS) and environments without
 * a pool run inline. Drop-in async form of `sanitizeEntryHtml`.
 *
 * Intended for app-server request paths (saved articles, on-demand full-content
 * fetch, read-path re-sanitize). Background jobs (feed fetching, email ingest)
 * deliberately sanitize inline — they already run off the request path, so the
 * extra thread hop and string copy would be pure overhead.
 */
export async function sanitizeEntryHtmlInWorker(
  html: string | null | undefined
): Promise<string | null> {
  if (!html) return null;

  const p = getPool();
  if (!p || html.length <= SANITIZE_INLINE_MAX_CHARS) {
    return sanitizeEntryHtml(html);
  }

  try {
    const result = await p.run({ type: "sanitizeEntryHtml", html });
    return sanitizeEntryHtmlResultSchema.parse(result).sanitized;
  } catch (error) {
    // A task-level failure (worker crash/OOM on a pathological body, bad result)
    // must not fail the caller — the read-path self-heal calls this, so a
    // rejection would turn entries.get into a 500. Fall back to inline, matching
    // the pool-unavailable path above.
    logger.warn("Worker sanitize failed; falling back to inline sanitize", {
      error: error instanceof Error ? error.message : String(error),
    });
    return sanitizeEntryHtml(html);
  }
}

/**
 * Report the `SANITIZER_VERSION` compiled into the worker-thread bundle.
 *
 * The bundle (`dist/worker-thread.js` in production) embeds a snapshot of the
 * sanitizer rules (`SANITIZE_OPTIONS` + pre-sanitization transforms) at build
 * time, while the main process imports the current `SANITIZER_VERSION` from
 * source. A stale bundle therefore sanitizes with out-of-date rules even though
 * the main process stamps rows with the current version — silently persisting
 * mis-sanitized content. Comparing this value to the main process's
 * `SANITIZER_VERSION` detects that mismatch (the bump discipline makes the
 * version the single source of truth for the rules). Bulk re-sanitization refuses
 * to run on a mismatch; see scripts/resanitize-bulk.ts.
 *
 * Runs the probe in the pool (bypassing the inline-size threshold) so it actually
 * reflects the bundle. When no pool is available every sanitize runs inline on
 * the main thread with current rules, so there is no bundle to be stale — we
 * return the in-process version, which always matches.
 */
export async function getWorkerSanitizerVersion(): Promise<number> {
  const p = getPool();
  if (!p) return SANITIZER_VERSION;

  const result = await p.run({ type: "sanitizerVersion" });
  return sanitizerVersionResultSchema.parse(result).version;
}

/**
 * Parse a feed string, auto-detecting format (runs in a worker thread).
 *
 * Drop-in async replacement for the synchronous `parseFeed` from
 * `@/server/feed/parser`. Falls back to inline execution if the worker
 * pool is unavailable.
 */
export async function parseFeedInWorker(content: string): Promise<ParsedFeed> {
  const p = getPool();
  if (!p) {
    const { parseFeed } = await import("@/server/feed/parser");
    return parseFeed(content);
  }

  const raw = await p.run({ type: "parseFeed", content });
  const result = serializedParsedFeedSchema.parse(raw);
  return deserializeParsedFeed(result);
}

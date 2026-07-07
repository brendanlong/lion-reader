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
import { sanitizeEntryHtml } from "@/server/html/sanitize";
import {
  cleanedContentSchema,
  sanitizeEntryHtmlResultSchema,
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

  // Production: compiled JS bundle
  const distPath = resolve(cwd, "dist/worker-thread.js");
  if (existsSync(distPath)) {
    return { filename: distPath };
  }

  // Development: run the TS source via tsx loader
  const srcPath = resolve(cwd, "src/server/worker-thread/worker.ts");
  return {
    filename: srcPath,
    execArgv: ["--import", "tsx"],
  };
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

  const result = await p.run({ type: "sanitizeEntryHtml", html });
  return sanitizeEntryHtmlResultSchema.parse(result).sanitized;
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

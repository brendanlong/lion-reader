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
import { cleanedContentSchema, serializedParsedFeedSchema, deserializeParsedFeed } from "./types";
import type { CleanedContent, CleanContentOptions, ParsedFeed } from "./types";

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
  options?: CleanContentOptions
): Promise<CleanedContent | null> {
  const p = getPool();
  if (!p) {
    const { cleanContent } = await import("@/server/feed/content-cleaner");
    return cleanContent(html, options) ?? null;
  }

  const result = await p.run({ type: "cleanContent", html, options });
  if (result === null) return null;
  return cleanedContentSchema.parse(result);
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

/**
 * Destroy the worker pool. Call during graceful shutdown.
 */
export async function destroyWorkerPool(): Promise<void> {
  if (pool) {
    await pool.destroy();
    pool = null;
    logger.info("Worker thread pool destroyed");
  }
}

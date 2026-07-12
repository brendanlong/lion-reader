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
/**
 * Set once the worker bundle's `SANITIZER_VERSION` has been confirmed to match
 * the main process, so the probe runs at most once in the happy path.
 */
let sanitizerVersionVerified = false;
/**
 * The in-flight bundle-version probe, shared by concurrent first callers. Reset
 * to null after a *transient* probe error so the next call retries (only a real
 * version mismatch permanently disables the pool).
 */
let sanitizerVersionProbe: Promise<"ok" | "mismatch" | "error"> | null = null;
/**
 * Upper bound on the version probe. A cold thread spawn answers in well under a
 * second; 15s only trips when the thread is wedged (wrong module loaded, event
 * loop blocked), where waiting longer can't help and inline is the right call.
 */
const PROBE_TIMEOUT_MS = 15_000;

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

/**
 * Runs the one-time bundle-version probe against the pool. A stale
 * `dist/worker-thread.js` embeds an out-of-date `SANITIZE_OPTIONS`/transform
 * snapshot, so it would sanitize offloaded bodies with old rules while the main
 * process stamps rows with the current `SANITIZER_VERSION` — silently persisting
 * mis-sanitized HTML the version-gated self-heal never revisits. On mismatch we
 * disable the pool entirely so every sanitize runs inline on the main thread
 * with the current rules.
 */
async function verifyWorkerSanitizerVersion(p: Piscina): Promise<"ok" | "mismatch" | "error"> {
  let version: number;
  try {
    // The probe must be bounded: a thread whose entry module loads but never
    // speaks piscina's task protocol (e.g. the wrong file resolved into the
    // thread — bundled piscina once resolved its bootstrap to dist/worker.js,
    // the standalone job worker) leaves p.run() pending forever, and every
    // offload caller awaits this shared probe — so an unbounded probe freezes
    // every save/sanitize in the process instead of degrading to inline.
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`sanitizer version probe timed out after ${PROBE_TIMEOUT_MS}ms`)),
        PROBE_TIMEOUT_MS
      );
    });
    try {
      const result = await Promise.race([p.run({ type: "sanitizerVersion" }), timeout]);
      version = sanitizerVersionResultSchema.parse(result).version;
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    // A transient worker crash/timeout (not a genuine version mismatch) must not
    // permanently disable offload — the caller retries on the next call.
    logger.warn("Worker sanitizer version probe failed; sanitizing inline for now, will retry", {
      error: error instanceof Error ? error.message : String(error),
    });
    return "error";
  }
  if (version !== SANITIZER_VERSION) {
    logger.error(
      "Worker thread bundle SANITIZER_VERSION mismatch — disabling worker pool, sanitizing inline. Rebuild the worker bundle (build:all).",
      { workerVersion: version, mainVersion: SANITIZER_VERSION }
    );
    return "mismatch";
  }
  return "ok";
}

/**
 * Returns the pool only after confirming the worker bundle's sanitizer version
 * matches the main process. A genuine version *mismatch* tears the pool down and
 * permanently disables it (all callers then fall back to inline execution with
 * current rules). A transient probe *error* only skips offload for the current
 * call and is retried next time — a one-off worker blip mustn't disable offload
 * for the whole process. The successful probe runs at most once.
 */
async function getVerifiedPool(): Promise<Piscina | null> {
  const p = getPool();
  if (!p) return null;
  if (sanitizerVersionVerified) return p;

  if (!sanitizerVersionProbe) {
    sanitizerVersionProbe = verifyWorkerSanitizerVersion(p);
  }
  const outcome = await sanitizerVersionProbe;

  if (outcome === "ok") {
    sanitizerVersionVerified = true;
    return p;
  }
  if (outcome === "mismatch") {
    poolInitFailed = true;
    if (pool) {
      const stale = pool;
      pool = null;
      void stale.destroy().catch(() => {});
    }
    return null;
  }
  // Transient error: don't memoize, retry on the next call, run inline for now.
  sanitizerVersionProbe = null;
  return null;
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
  const p = await getVerifiedPool();
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

  // Small bodies sanitize inline (cheaper than the thread hop), so skip the pool
  // — and its version probe — entirely for them.
  if (html.length <= SANITIZE_INLINE_MAX_CHARS) {
    return sanitizeEntryHtml(html);
  }

  const p = await getVerifiedPool();
  if (!p) {
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
 * to run on a mismatch (see scripts/resanitize-bulk.ts), and the pool itself runs
 * the same probe once at first use (`getVerifiedPool`), disabling offload on a
 * mismatch so app-server request paths never persist stale-sanitized HTML.
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
  const p = await getVerifiedPool();
  if (!p) {
    const { parseFeed } = await import("@/server/feed/parser");
    return parseFeed(content);
  }

  const raw = await p.run({ type: "parseFeed", content });
  const result = serializedParsedFeedSchema.parse(raw);
  return deserializeParsedFeed(result);
}

/**
 * Worker thread pool for CPU-intensive operations.
 *
 * Provides an async wrapper around parseFeed that runs the actual work in a
 * piscina worker thread, keeping the main event loop free for handling API
 * requests. (Content cleaning and sanitization are native modules now and
 * run on the libuv thread pool instead — see cleanContentInWorker and
 * sanitizeEntryHtmlInWorker below.)
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
import { cleanContentAsync } from "@/server/feed/content-cleaner";
import type {
  CleanContentOptions,
  CleanedContent as RawCleanedContent,
} from "@/server/feed/content-cleaner";
import {
  sanitizeEntryHtml,
  sanitizeEntryHtmlAsync,
  SANITIZER_VERSION,
} from "@/server/html/sanitize";
import {
  sanitizerVersionResultSchema,
  serializedParsedFeedSchema,
  deserializeParsedFeed,
} from "./types";
import type { ParsedFeed } from "./types";

/**
 * Return shape of `cleanContentInWorker`: the cleaned content, plus the
 * sanitized form of it when the caller requested `sanitizeCleaned` (so a
 * caller that persists the cleaned content doesn't sanitize it again).
 */
export type CleanedContent = RawCleanedContent & {
  contentSanitized?: string | null;
};

/**
 * Bodies at or below this size are sanitized synchronously on the calling
 * thread: the native sanitizer runs in well under a millisecond for them, so
 * the fixed cost of scheduling a libuv-thread-pool task (and copying the
 * string across the N-API boundary twice) isn't worth paying. Larger bodies
 * run async on the libuv pool so they never stall UI-serving requests on the
 * app-server event loop. ~10 KB.
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
 * Clean HTML content using the Readability algorithm without blocking the
 * main event loop for large pages. Drop-in async form of `cleanContent`.
 *
 * Extraction is a native module (dom_smoothie) now, so this no longer
 * involves the piscina pool at all: `cleanContentAsync` runs the extractor
 * on the libuv thread pool (no string structured-clone, no bundle-version
 * concerns — the same .node module serves every thread), and the optional
 * sanitize of the cleaned output goes through `sanitizeEntryHtmlInWorker`
 * (also native). The old fused clean+sanitize piscina task existed to avoid
 * shipping the cleaned string across the thread boundary twice; with both
 * steps native, each hop is a single N-API string copy (~1% of the work),
 * so plain composition replaces the fusion.
 *
 * Intended for app-server request paths (saved articles, on-demand
 * full-content fetch). Background jobs (feed fetching, email ingest)
 * deliberately use the synchronous `cleanContent` — they already run off the
 * request path, so the async hop would be pure overhead.
 */
export async function cleanContentInWorker(
  html: string,
  options?: CleanContentOptions,
  extra?: { sanitizeCleaned?: boolean }
): Promise<CleanedContent | null> {
  const cleaned = await cleanContentAsync(html, options);
  if (!cleaned) return null;
  return extra?.sanitizeCleaned
    ? { ...cleaned, contentSanitized: await sanitizeEntryHtmlInWorker(cleaned.content) }
    : cleaned;
}

/**
 * Sanitize entry-content HTML without blocking the main event loop for large
 * bodies. Drop-in async form of `sanitizeEntryHtml`.
 *
 * The native sanitizer runs the pipeline on the libuv thread pool for bodies
 * above the inline threshold, so this no longer involves the piscina pool at
 * all (no string structured-clone, no bundle-version concerns — the same
 * .node module serves every thread). Small bodies run synchronously, which
 * is cheaper than scheduling a task.
 *
 * Intended for app-server request paths (saved articles, on-demand full-content
 * fetch, read-path re-sanitize). Background jobs (feed fetching, email ingest)
 * deliberately use the synchronous `sanitizeEntryHtml` — they already run off
 * the request path, so the async hop would be pure overhead.
 */
export async function sanitizeEntryHtmlInWorker(
  html: string | null | undefined
): Promise<string | null> {
  if (!html) return null;
  if (html.length <= SANITIZE_INLINE_MAX_CHARS) {
    return sanitizeEntryHtml(html);
  }
  return sanitizeEntryHtmlAsync(html);
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

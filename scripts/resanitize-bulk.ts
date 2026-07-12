/**
 * Bulk re-sanitization tool.
 *
 * Re-sanitizes stored entry HTML across the whole corpus as fast as a machine
 * can, so a `SANITIZER_VERSION` bump can be rolled out in minutes on a beefy,
 * temporary box. This is the deliberate, operator-run path for converging the
 * long tail of entries nobody opens — the read-path self-heal only fixes
 * entries that are actually read, and the old `resanitize_entries` background
 * sweep was removed for costing too much database CPU (issue #1116). It shares
 * the read path's guarded write (`persistResanitizedFamily`), so it's safe to
 * run concurrently with the live app and with normal writes — the two-part
 * compare-and-swap makes every write a no-op unless the row's stored version is
 * still *strictly older* than ours and its raw content is unchanged (so a row a
 * newer release already wrote is never downgraded).
 *
 * Before doing anything it probes the worker-thread pool's compiled-in
 * `SANITIZER_VERSION` and refuses to run if it doesn't match the main process
 * (`assertWorkerBundleCurrent`): a stale `dist/worker-thread.js` would sanitize
 * large bodies with out-of-date rules while stamping rows current — silently
 * locking in mis-sanitized content — so we fail loudly instead. This makes it
 * safe to run in production mode; rebuild the bundle with
 * `pnpm build:worker-thread` if the preflight complains.
 *
 * ## Architecture: an overlapped producer/consumer pipeline with backpressure
 *
 * The naive approach — "fetch a chunk (all I/O, no CPU), then fan the chunk out
 * to the sanitizer workers (all CPU, no I/O), repeat" — wastes half the wall
 * clock: the DB sits idle while the CPU chews, and the CPU sits idle while the DB
 * fetches. Instead this runs both at once:
 *
 *   - A single **producer** walks the stale rows by keyset over
 *     `(stalenessKey, id)` in chunks and pushes each row into a bounded queue.
 *   - `concurrency` **consumers** each pull one row at a time and sanitize its
 *     stale families in the piscina worker pool, then persist under the CAS guard.
 *
 * The queue is **bounded** (capacity `chunkSize * prefetchChunks`): when it's
 * full the producer's `push` awaits, so we never fetch rows faster than the
 * workers drain them (no unbounded memory growth, no giant piscina backlog). When
 * it drains below capacity the producer wakes and fetches the next chunk *while
 * the consumers keep working* — so DB fetches overlap CPU sanitization instead of
 * alternating with it. Pulling one row at a time (rather than one chunk at a time)
 * keeps all `concurrency` workers busy across chunk boundaries, avoiding the tail
 * stall where a chunk's last few rows finish with most workers idle.
 *
 * ## Row selection
 *
 * We page the stale set (`RESANITIZE_STALENESS_KEY < SANITIZER_VERSION`) via the
 * shared `selectStaleEntriesForResanitize`, ordered by the staleness key
 * descending (then `id` descending) and keyset-paginated on `(stalenessKey, id)`.
 * That ordering is exactly what `idx_entries_resanitize` provides, so every chunk
 * is an index range seek into the stale rows — never a full table scan. This
 * matters most *between* version bumps, when only a sparse scattering of rows is
 * stale (or none): the earlier `ORDER BY id` walked `entries_pkey` and evaluated
 * the staleness expression as a filter on every row, so a near-caught-up corpus
 * cost a near-full-table scan per page just to find a handful of matches. Seeking
 * the index instead makes an empty stale set return immediately.
 *
 * The cursor only moves toward smaller `(key, id)`, and healed rows leave the
 * stale range entirely (their key jumps to `SANITIZER_VERSION`), so we never
 * re-fetch a row we already passed — nor one the read-path self-heal or a normal
 * write healed ahead of us. No cursor is persisted across runs; a fresh run just
 * re-seeks the current stale range from the top.
 *
 * ## Usage
 *
 *   dotenv -- tsx scripts/resanitize-bulk.ts
 *
 * Config (CLI flag or env var; flag wins):
 *   --chunk-size N     / RESANITIZE_CHUNK_SIZE      rows fetched per DB query (default 500)
 *   --concurrency N    / RESANITIZE_CONCURRENCY     concurrent entries in flight (default: CPU count)
 *   --prefetch N       / RESANITIZE_PREFETCH_CHUNKS queue depth in chunks (default 2)
 *   --limit N          / RESANITIZE_LIMIT           stop after ~N entries (default: all)
 *
 * The worker-thread pool size defaults to `concurrency` (override with
 * WORKER_THREAD_POOL_SIZE) so all in-flight sanitizations can run in parallel.
 * Set PG_POOL_MAX high enough to cover `concurrency` persist connections plus the
 * producer's fetches (default pool is 20).
 */

import { db, pool } from "../src/server/db";
import { SANITIZER_VERSION } from "../src/server/html/sanitize";
import {
  isSanitizedFamilyStale,
  persistResanitizedFamily,
  selectStaleEntriesForResanitize,
} from "../src/server/services/resanitize";
import {
  getWorkerSanitizerVersion,
  sanitizeEntryHtmlInWorker,
} from "../src/server/worker-thread/pool";
import { availableParallelism } from "os";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function readOption(flag: string, envVar: string): string | undefined {
  const argv = process.argv.slice(2);
  const idx = argv.indexOf(flag);
  if (idx !== -1 && idx + 1 < argv.length) return argv[idx + 1];
  const eq = argv.find((a) => a.startsWith(`${flag}=`));
  if (eq) return eq.slice(flag.length + 1);
  return process.env[envVar];
}

function readIntOption(flag: string, envVar: string, fallback: number): number {
  const raw = readOption(flag, envVar);
  if (raw === undefined) return fallback;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`Invalid value for ${flag}/${envVar}: ${raw}`);
  }
  return n;
}

const CHUNK_SIZE = readIntOption("--chunk-size", "RESANITIZE_CHUNK_SIZE", 500);
const CONCURRENCY = readIntOption(
  "--concurrency",
  "RESANITIZE_CONCURRENCY",
  availableParallelism()
);
const PREFETCH_CHUNKS = readIntOption("--prefetch", "RESANITIZE_PREFETCH_CHUNKS", 2);
const LIMIT = readIntOption("--limit", "RESANITIZE_LIMIT", Number.MAX_SAFE_INTEGER);

// Default the sanitize worker pool to `concurrency` threads so every in-flight
// sanitization can actually run in parallel (the pool otherwise caps at
// min(4, cores/2)). Set before the first pool.run() so lazy init picks it up.
if (!process.env.WORKER_THREAD_POOL_SIZE) {
  process.env.WORKER_THREAD_POOL_SIZE = String(CONCURRENCY);
}

// ---------------------------------------------------------------------------
// Bounded async queue (single producer, N consumers)
// ---------------------------------------------------------------------------

/**
 * FIFO queue with a hard capacity. `push` awaits while full (producer
 * backpressure); `pull` awaits while empty. Once `close()`d and drained, `pull`
 * returns `null` forever so consumers can exit their loops.
 */
class BoundedQueue<T> {
  private readonly buf: T[] = [];
  private closed = false;
  private readonly notFull: Array<() => void> = [];
  private readonly notEmpty: Array<() => void> = [];

  constructor(private readonly capacity: number) {}

  async push(item: T): Promise<void> {
    while (this.buf.length >= this.capacity && !this.closed) {
      await new Promise<void>((resolve) => this.notFull.push(resolve));
    }
    if (this.closed) return;
    this.buf.push(item);
    this.notEmpty.shift()?.();
  }

  async pull(): Promise<T | null> {
    while (this.buf.length === 0 && !this.closed) {
      await new Promise<void>((resolve) => this.notEmpty.push(resolve));
    }
    const item = this.buf.shift();
    if (item === undefined) return null; // closed and drained
    this.notFull.shift()?.();
    return item;
  }

  close(): void {
    this.closed = true;
    // Wake everyone so blocked producers/consumers re-check and exit.
    while (this.notEmpty.length) this.notEmpty.shift()?.();
    while (this.notFull.length) this.notFull.shift()?.();
  }
}

// ---------------------------------------------------------------------------
// Row selection + per-row work
// ---------------------------------------------------------------------------

// Row shape and query come from the shared service so the EXPLAIN-tested
// staleness query (backed by idx_entries_resanitize) can't drift from this
// script's usage.
type StaleRow = Awaited<ReturnType<typeof selectStaleEntriesForResanitize>>[number];

/** Keyset cursor over the index ordering `(stalenessKey DESC, id DESC)`. */
type Cursor = { stalenessKey: number; id: string };

/** Fetch the next chunk of stale rows after the keyset cursor (or from the top). */
function fetchChunk(cursor: Cursor | null, limit: number): Promise<StaleRow[]> {
  return selectStaleEntriesForResanitize(db, limit, cursor ?? undefined);
}

type RowOutcome = { content: boolean; fullContent: boolean; failed: boolean };

/**
 * Re-sanitize one row's stale families in the worker pool and persist under the
 * CAS guard. A family is healed only when it has raw content and its stored
 * version is behind (`isSanitizedFamilyStale`), matching the staleness key.
 * Offloads the sanitize to the piscina pool (`sanitizeEntryHtmlInWorker`) so
 * the main thread stays free to keep fetching. Never throws — a pathological
 * body is logged and counted, so one poison row can't wedge the run.
 */
async function resanitizeRow(row: StaleRow): Promise<RowOutcome> {
  try {
    let content = false;
    let fullContent = false;

    const contentHasRaw = row.contentOriginal !== null || row.contentCleaned !== null;
    if (contentHasRaw && isSanitizedFamilyStale(row.contentSanitizedVersion)) {
      const [original, cleaned] = await Promise.all([
        sanitizeEntryHtmlInWorker(row.contentOriginal),
        sanitizeEntryHtmlInWorker(row.contentCleaned),
      ]);
      content = await persistResanitizedFamily(
        db,
        row.id,
        "content",
        { original, cleaned },
        row.contentHash
      );
    }

    const fullHasRaw = row.fullContentOriginal !== null || row.fullContentCleaned !== null;
    if (fullHasRaw && isSanitizedFamilyStale(row.fullContentSanitizedVersion)) {
      const [original, cleaned] = await Promise.all([
        sanitizeEntryHtmlInWorker(row.fullContentOriginal),
        sanitizeEntryHtmlInWorker(row.fullContentCleaned),
      ]);
      fullContent = await persistResanitizedFamily(
        db,
        row.id,
        "fullContent",
        { original, cleaned },
        row.fullContentHash
      );
    }

    return { content, fullContent, failed: false };
  } catch (error) {
    console.error(
      `[resanitize] failed entry ${row.id}: ${error instanceof Error ? error.message : String(error)}`
    );
    return { content: false, fullContent: false, failed: true };
  }
}

// ---------------------------------------------------------------------------
// Preflight: refuse to run against a stale worker bundle
// ---------------------------------------------------------------------------

/**
 * The worker-thread bundle embeds a snapshot of the sanitizer rules at build
 * time. If it's stale, large bodies (which offload to the pool) would be
 * sanitized with out-of-date rules while every row is stamped with the current
 * `SANITIZER_VERSION` — silently locking in mis-sanitized content that the
 * version-gated self-heal will never revisit. That's especially dangerous for a
 * security-tightening bump, the exact case this tool exists to roll out fast. So
 * we probe the worker's compiled-in version up front and refuse to run unless it
 * matches, rather than corrupt the corpus. (Running from source with NODE_ENV
 * unset uses the src worker via tsx and always matches; the risk is a built
 * `dist/worker-thread.js` left stale after a sanitizer change — rebuild it with
 * `pnpm build:worker-thread`.)
 */
async function assertWorkerBundleCurrent(): Promise<void> {
  let workerVersion: number;
  try {
    workerVersion = await getWorkerSanitizerVersion();
  } catch (error) {
    throw new Error(
      `Could not verify the worker-thread sanitizer version ` +
        `(${error instanceof Error ? error.message : String(error)}). The worker bundle ` +
        `(dist/worker-thread.js) is likely stale or incompatible — rebuild it with ` +
        `'pnpm build:worker-thread' (or run from source with NODE_ENV unset) and retry.`
    );
  }
  if (workerVersion !== SANITIZER_VERSION) {
    throw new Error(
      `Worker sanitizer version mismatch: the main process is at v${SANITIZER_VERSION} but ` +
        `the worker bundle sanitizes at v${workerVersion}. Running would stamp rows as ` +
        `v${SANITIZER_VERSION} while sanitizing large bodies with v${workerVersion} rules. ` +
        `Rebuild the worker with 'pnpm build:worker-thread' (or run from source with ` +
        `NODE_ENV unset) and retry.`
    );
  }
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  await assertWorkerBundleCurrent();

  console.log(
    `[resanitize] starting: sanitizer v${SANITIZER_VERSION}, chunkSize=${CHUNK_SIZE}, ` +
      `concurrency=${CONCURRENCY}, prefetch=${PREFETCH_CHUNKS} chunks, ` +
      `poolThreads=${process.env.WORKER_THREAD_POOL_SIZE}` +
      (LIMIT === Number.MAX_SAFE_INTEGER ? "" : `, limit=${LIMIT}`)
  );

  const queue = new BoundedQueue<StaleRow>(CHUNK_SIZE * PREFETCH_CHUNKS);
  const startedAt = Date.now();

  let fetched = 0;
  let processed = 0;
  let contentHealed = 0;
  let fullContentHealed = 0;
  let failed = 0;

  // Producer: walk the stale set by keyset and feed the queue. `push` provides
  // backpressure, so this stays at most PREFETCH_CHUNKS ahead of the consumers.
  const producer = (async () => {
    let cursor: Cursor | null = null;
    while (fetched < LIMIT) {
      const remaining = LIMIT - fetched;
      const chunk = await fetchChunk(cursor, Math.min(CHUNK_SIZE, remaining));
      if (chunk.length === 0) break;
      const last = chunk[chunk.length - 1];
      cursor = { stalenessKey: last.stalenessKey, id: last.id };
      fetched += chunk.length;
      for (const row of chunk) {
        await queue.push(row);
      }
    }
    queue.close();
  })();

  const PROGRESS_EVERY = Math.max(CHUNK_SIZE, 1000);
  let nextProgressAt = PROGRESS_EVERY;

  // Consumers: pull one row at a time and process it. Sized to CONCURRENCY so
  // exactly that many entries are in flight (bounding piscina's backlog too).
  const consumers = Array.from({ length: CONCURRENCY }, () =>
    (async () => {
      for (;;) {
        const row = await queue.pull();
        if (row === null) break;
        const outcome = await resanitizeRow(row);
        processed++;
        if (outcome.content) contentHealed++;
        if (outcome.fullContent) fullContentHealed++;
        if (outcome.failed) failed++;

        if (processed >= nextProgressAt) {
          nextProgressAt += PROGRESS_EVERY;
          const elapsedS = (Date.now() - startedAt) / 1000;
          const rate = Math.round(processed / elapsedS);
          console.log(
            `[resanitize] processed=${processed} content=${contentHealed} ` +
              `full=${fullContentHealed} failed=${failed} (${rate}/s)`
          );
        }
      }
    })()
  );

  await Promise.all([producer, ...consumers]);

  const elapsedS = (Date.now() - startedAt) / 1000;
  console.log(
    `[resanitize] done in ${elapsedS.toFixed(1)}s: processed=${processed} ` +
      `contentHealed=${contentHealed} fullContentHealed=${fullContentHealed} failed=${failed} ` +
      `(${Math.round(processed / Math.max(elapsedS, 0.001))}/s)`
  );
}

main()
  .then(async () => {
    await pool.end();
    // Piscina keeps a min thread alive; exit explicitly so the script returns.
    process.exit(0);
  })
  .catch(async (error) => {
    console.error("[resanitize] fatal error:", error);
    await pool.end().catch(() => {});
    process.exit(1);
  });

/**
 * Moves every stored `entries.full_content_original` into the archive bucket
 * and clears the column (#2115), in two steps so production never ships its
 * pages anywhere:
 *
 *   pnpm exec tsx scripts/archive-full-content-originals.ts upload <manifest> [--batch-size 50] [--pause-ms 0]
 *   pnpm exec tsx scripts/archive-full-content-originals.ts clear <manifest> [--batch-size 200] [--pause-ms 1000]
 *
 * `upload` runs against a restore of production (DATABASE_URL pointing at it,
 * plus the STORAGE_* variables, STORAGE_ARCHIVE_BUCKET included). Take the
 * restore after the deploy that stops writing the column has rolled out. It
 * walks `entries` in id order, archives each page, and appends a line per
 * archived row to the manifest (JSON: the id and its fetch time). Rerun, it
 * resumes after the manifest's last row; a failed upload is left out, so a
 * later upload run picks it up.
 *
 * `clear` runs against production, reading only the manifest. A plugin fetch
 * from before 4d18f516 stored its article only as the original; it moves into
 * `full_content_cleaned`, which the read path falls back to meanwhile, so
 * nothing a reader sees changes. A row whose fetch time differs from the
 * manifest's (every write of the column also set it) holds a page the upload
 * didn't archive, so it's left alone. Rerun both until `upload` archives
 * nothing on a fresh restore.
 *
 * A batch's uploads run in parallel, so `upload`'s `--batch-size` is also how
 * many uploads are in flight. `--pause-ms` spaces batches out so neither step
 * saturates the database's I/O.
 */

import { fileURLToPath } from "node:url";
import { appendFile, readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { sql } from "drizzle-orm";
import type { db as dbType } from "../src/server/db";
import { isArchiveAvailable } from "../src/server/storage/s3";
import { archiveFullContentOriginal } from "../src/server/services/full-content-archive";

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

/** One archived row, as the manifest records it. */
interface ArchivedRow {
  id: string;
  /** `full_content_fetched_at` as text, to compare at full precision. */
  fetchedAt: string | null;
}

interface BatchOptions {
  batchSize?: number;
  pauseMs?: number;
  log?: (message: string) => void;
}

async function readManifest(path: string): Promise<ArchivedRow[]> {
  const text = await readFile(path, "utf8").catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return "";
    throw err;
  });
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as ArchivedRow);
}

interface UploadRow extends Record<string, unknown> {
  id: string;
  original: string;
  fetched_at: string | null;
}

/** Archives every stored page after the manifest's last row, appending to it. */
export async function uploadFullContentOriginals(
  db: typeof dbType,
  manifestPath: string,
  { batchSize = 50, pauseMs = 0, log = () => {} }: BatchOptions = {}
): Promise<{ archived: number; failedUploads: number }> {
  if (!isArchiveAvailable()) {
    throw new Error("The archive bucket isn't configured");
  }

  let cursor = (await readManifest(manifestPath)).at(-1)?.id ?? NIL_UUID;
  let archived = 0;
  let failedUploads = 0;
  for (;;) {
    const { rows } = await db.execute<UploadRow>(sql`
      SELECT id, full_content_original AS original, full_content_fetched_at::text AS fetched_at
      FROM entries
      WHERE id > ${cursor}::uuid AND full_content_original IS NOT NULL
      ORDER BY id
      LIMIT ${batchSize}
    `);
    if (rows.length === 0) break;

    // Uploads are independent (each page has its own key), so a batch's run
    // at once: `--batch-size` is also the upload concurrency.
    const results = await Promise.allSettled(
      rows.map((row) => archiveFullContentOriginal(row.id, row.original))
    );
    const lines: string[] = [];
    results.forEach((result, i) => {
      const row = rows[i];
      if (result.status === "fulfilled") {
        lines.push(JSON.stringify({ id: row.id, fetchedAt: row.fetched_at } satisfies ArchivedRow));
      } else {
        failedUploads++;
        const err: unknown = result.reason;
        log(`upload failed for ${row.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
    if (lines.length > 0) await appendFile(manifestPath, lines.map((l) => `${l}\n`).join(""));
    archived += lines.length;

    cursor = rows[rows.length - 1].id;
    log(`archived ${lines.length} of ${rows.length}, after ${cursor}`);
    if (rows.length < batchSize) break;
    await sleep(pauseMs);
  }
  return { archived, failedUploads };
}

/** Clears the column on the manifest's rows that still hold the archived page. */
export async function clearArchivedOriginals(
  db: typeof dbType,
  manifestPath: string,
  { batchSize = 200, pauseMs = 1000, log = () => {} }: BatchOptions = {}
): Promise<{ cleared: number }> {
  const manifest = await readManifest(manifestPath);
  let cleared = 0;
  for (let i = 0; i < manifest.length; i += batchSize) {
    const batch = manifest.slice(i, i + batchSize);
    const result = await db.execute(sql`
      UPDATE entries e
      SET full_content_cleaned = COALESCE(e.full_content_cleaned, e.full_content_original),
          full_content_original = NULL
      FROM (VALUES ${sql.join(
        batch.map((row) => sql`(${row.id}::uuid, ${row.fetchedAt}::timestamptz)`),
        sql`, `
      )}) AS m(id, fetched_at)
      WHERE e.id = m.id
        AND e.full_content_original IS NOT NULL
        AND e.full_content_fetched_at IS NOT DISTINCT FROM m.fetched_at
    `);
    cleared += result.rowCount ?? 0;
    log(`cleared ${result.rowCount ?? 0} of ${batch.length}, through ${batch.at(-1)?.id}`);
    if (i + batchSize < manifest.length) await sleep(pauseMs);
  }
  return { cleared };
}

function parseArgs(argv: string[]): {
  command: "upload" | "clear";
  manifest: string;
  options: BatchOptions;
} {
  const [command, manifest, ...rest] = argv;
  if ((command !== "upload" && command !== "clear") || !manifest) {
    throw new Error("Usage: archive-full-content-originals.ts upload|clear <manifest> [options]");
  }
  const options: BatchOptions = { log: (m) => console.log(m) };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--batch-size") options.batchSize = Number(rest[++i]);
    else if (arg === "--pause-ms") options.pauseMs = Number(rest[++i]);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (options.batchSize !== undefined && !(options.batchSize > 0)) {
    throw new Error("--batch-size must be a positive number");
  }
  if (options.pauseMs !== undefined && !(options.pauseMs >= 0)) {
    throw new Error("--pause-ms must be a non-negative number");
  }
  return { command, manifest, options };
}

async function main(): Promise<void> {
  const { command, manifest, options } = parseArgs(process.argv.slice(2));
  const { db, pool } = await import("../src/server/db");
  try {
    const started = Date.now();
    const result =
      command === "upload"
        ? await uploadFullContentOriginals(db, manifest, options)
        : await clearArchivedOriginals(db, manifest, options);
    console.log(`Done in ${((Date.now() - started) / 1000).toFixed(1)} s:`, JSON.stringify(result));
    process.exitCode = "failedUploads" in result && result.failedUploads > 0 ? 1 : 0;
  } finally {
    await pool.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}

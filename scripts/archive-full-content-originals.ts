/**
 * Moves every stored `entries.full_content_original` into the archive bucket
 * and clears the column (#2115), a batch at a time.
 *
 * Usage, with DATABASE_URL and the STORAGE_* variables (STORAGE_ARCHIVE_BUCKET
 * included) set:
 *   pnpm exec tsx scripts/archive-full-content-originals.ts [--batch-size 50] [--pause-ms 1000] [--after <entry_id>]
 *
 * Walks `entries` in id order. Each batch uploads its pages, then clears the
 * column only on the rows whose upload succeeded, so a page is never dropped
 * before it's stored. Rerunning is safe and skips finished rows; each batch
 * logs its cursor, which `--after` resumes from. `--pause-ms` spaces batches
 * out so the walk doesn't saturate the database's I/O.
 *
 * A plugin fetch from before 4d18f516 stored its article only as the
 * original (no `full_content_cleaned`); it moves into `full_content_cleaned`,
 * which the read path falls back to meanwhile, so nothing a reader sees
 * changes. Run it once the deploy that stops writing the column has finished
 * rolling out: an old machine's write landing between a batch's read and its
 * update would be cleared without being archived.
 */

import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { sql } from "drizzle-orm";
import type { db as dbType } from "../src/server/db";
import { isArchiveAvailable } from "../src/server/storage/s3";
import { archiveFullContentOriginal } from "../src/server/services/full-content-archive";

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

export interface ArchiveOptions {
  batchSize?: number;
  pauseMs?: number;
  /** Resume the walk after this entry id. */
  after?: string;
  log?: (message: string) => void;
}

export interface ArchiveResult {
  archived: number;
  failedUploads: number;
}

interface BatchRow extends Record<string, unknown> {
  id: string;
  original: string;
}

export async function archiveFullContentOriginals(
  db: typeof dbType,
  { batchSize = 50, pauseMs = 1000, after = NIL_UUID, log = () => {} }: ArchiveOptions = {}
): Promise<ArchiveResult> {
  if (!isArchiveAvailable()) {
    throw new Error("The archive bucket isn't configured: refusing to drop the originals");
  }

  let cursor = after;
  let archived = 0;
  let failedUploads = 0;
  for (;;) {
    const { rows } = await db.execute<BatchRow>(sql`
      SELECT id, full_content_original AS original
      FROM entries
      WHERE id > ${cursor}::uuid AND full_content_original IS NOT NULL
      ORDER BY id
      LIMIT ${batchSize}
    `);
    if (rows.length === 0) break;

    const uploaded: string[] = [];
    for (const row of rows) {
      try {
        await archiveFullContentOriginal(row.id, row.original);
        uploaded.push(row.id);
      } catch (err) {
        failedUploads++;
        log(`upload failed for ${row.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // A fetch since the SELECT has already cleared the column (and archived
    // its own page), so only rows still holding a page are touched.
    if (uploaded.length > 0) {
      await db.execute(sql`
        UPDATE entries
        SET full_content_cleaned = COALESCE(full_content_cleaned, full_content_original),
            full_content_original = NULL
        WHERE id IN (${sql.join(
          uploaded.map((id) => sql`${id}::uuid`),
          sql`, `
        )})
          AND full_content_original IS NOT NULL
      `);
    }
    archived += uploaded.length;

    cursor = rows[rows.length - 1].id;
    log(`archived ${uploaded.length} of ${rows.length}, after ${cursor}`);
    if (rows.length < batchSize) break;
    await sleep(pauseMs);
  }

  return { archived, failedUploads };
}

function parseArgs(argv: string[]): ArchiveOptions {
  const options: ArchiveOptions = { log: (m) => console.log(m) };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--batch-size") options.batchSize = Number(argv[++i]);
    else if (arg === "--pause-ms") options.pauseMs = Number(argv[++i]);
    else if (arg === "--after") options.after = argv[++i];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (options.batchSize !== undefined && !(options.batchSize > 0)) {
    throw new Error("--batch-size must be a positive number");
  }
  if (options.pauseMs !== undefined && !(options.pauseMs >= 0)) {
    throw new Error("--pause-ms must be a non-negative number");
  }
  return options;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const { db, pool } = await import("../src/server/db");
  try {
    const started = Date.now();
    const result = await archiveFullContentOriginals(db, options);
    console.log(`Done in ${((Date.now() - started) / 1000).toFixed(1)} s:`, JSON.stringify(result));
    process.exitCode = result.failedUploads > 0 ? 1 : 0;
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

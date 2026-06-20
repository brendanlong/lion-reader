/**
 * Backfill script: populate the persisted sanitized entry HTML columns.
 *
 * The read path serves `entries.*_sanitized` directly when their stored
 * `*_sanitized_version` matches `SANITIZER_VERSION`, and otherwise re-sanitizes
 * from the raw columns and self-heals on next read (see `resolveSanitizedContent`
 * in the entries router). This script eagerly fills/refreshes those columns so
 * the heal doesn't have to happen lazily — useful after first introducing the
 * columns or after bumping `SANITIZER_VERSION`.
 *
 * It only touches rows whose sanitized version is missing or stale AND which
 * actually have raw content for that family, and it derives the sanitized
 * columns through the same `withSanitizedEntryContent` helper every write path
 * uses, so the output is identical to what the read-path heal would produce.
 * Safe to re-run (idempotent) and safe to interrupt (cursor-based, commits each
 * batch).
 *
 * Usage:
 *   DATABASE_URL=postgres://... pnpm exec tsx scripts/backfill-sanitized-content.ts [--dry-run]
 *
 * Optional env:
 *   BATCH_SIZE   rows fetched/updated per batch (default 50). Raw content can be
 *                ~700KB/field × 4 fields, so keep this modest to bound memory.
 *   UPDATE_CONCURRENCY  parallel UPDATEs per batch (default 10).
 */

import { drizzle } from "drizzle-orm/node-postgres";
import { and, asc, gt, isNotNull, ne, or, sql, eq, type SQL } from "drizzle-orm";
import { Pool } from "pg";

import * as schema from "../src/server/db/schema";
import { entries } from "../src/server/db/schema";
import { SANITIZER_VERSION } from "../src/server/html/sanitize";
import { withSanitizedEntryContent } from "../src/server/html/sanitize-entry";

const DRY_RUN = process.argv.includes("--dry-run");
const BATCH_SIZE = Number(process.env.BATCH_SIZE ?? 50);
const UPDATE_CONCURRENCY = Number(process.env.UPDATE_CONCURRENCY ?? 10);

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("DATABASE_URL environment variable is not set");
  process.exit(1);
}

const pool = new Pool({ connectionString });
const db = drizzle(pool, { schema });

// A row needs work on the short-content family if its sanitized version is
// stale (NULL or != SANITIZER_VERSION) and it has at least one raw field.
const contentStale = and(
  or(
    sql`${entries.contentSanitizedVersion} IS NULL`,
    ne(entries.contentSanitizedVersion, SANITIZER_VERSION)
  ),
  or(isNotNull(entries.contentOriginal), isNotNull(entries.contentCleaned))
);

const fullContentStale = and(
  or(
    sql`${entries.fullContentSanitizedVersion} IS NULL`,
    ne(entries.fullContentSanitizedVersion, SANITIZER_VERSION)
  ),
  or(isNotNull(entries.fullContentOriginal), isNotNull(entries.fullContentCleaned))
);

const needsBackfill = or(contentStale, fullContentStale);

const SANITIZED_KEYS = [
  "contentOriginalSanitized",
  "contentCleanedSanitized",
  "contentSanitizedVersion",
  "fullContentOriginalSanitized",
  "fullContentCleanedSanitized",
  "fullContentSanitizedVersion",
] as const;

async function main() {
  console.log(
    `Backfilling sanitized entry content (SANITIZER_VERSION=${SANITIZER_VERSION}, batch=${BATCH_SIZE}, concurrency=${UPDATE_CONCURRENCY})${
      DRY_RUN ? " [dry run]" : ""
    }`
  );

  // Cursor over UUIDv7 ids (ascending == roughly chronological). Rows we update
  // stop matching `needsBackfill`, but the cursor only moves forward so we never
  // revisit and the loop terminates once a short batch comes back.
  let cursor: string | null = null;
  let scanned = 0;
  let updated = 0;

  for (;;) {
    const where: SQL | undefined = cursor
      ? and(needsBackfill, gt(entries.id, cursor))
      : needsBackfill;

    const batch = await db
      .select({
        id: entries.id,
        contentOriginal: entries.contentOriginal,
        contentCleaned: entries.contentCleaned,
        contentSanitizedVersion: entries.contentSanitizedVersion,
        fullContentOriginal: entries.fullContentOriginal,
        fullContentCleaned: entries.fullContentCleaned,
        fullContentSanitizedVersion: entries.fullContentSanitizedVersion,
      })
      .from(entries)
      .where(where)
      .orderBy(asc(entries.id))
      .limit(BATCH_SIZE);

    if (batch.length === 0) break;

    cursor = batch[batch.length - 1].id;
    scanned += batch.length;

    // Build the update set per row, refreshing only the stale families present.
    const updates = batch.map((row) => {
      const input: {
        contentOriginal?: string | null;
        contentCleaned?: string | null;
        fullContentOriginal?: string | null;
        fullContentCleaned?: string | null;
      } = {};

      const contentNeedsWork =
        row.contentSanitizedVersion !== SANITIZER_VERSION &&
        (row.contentOriginal !== null || row.contentCleaned !== null);
      if (contentNeedsWork) {
        input.contentOriginal = row.contentOriginal;
        input.contentCleaned = row.contentCleaned;
      }

      const fullContentNeedsWork =
        row.fullContentSanitizedVersion !== SANITIZER_VERSION &&
        (row.fullContentOriginal !== null || row.fullContentCleaned !== null);
      if (fullContentNeedsWork) {
        input.fullContentOriginal = row.fullContentOriginal;
        input.fullContentCleaned = row.fullContentCleaned;
      }

      const sanitized = withSanitizedEntryContent(input);
      const set: Record<string, string | number | null> = {};
      for (const key of SANITIZED_KEYS) {
        if (key in sanitized) {
          set[key] = sanitized[key] as string | number | null;
        }
      }
      return { id: row.id, set };
    });

    if (!DRY_RUN) {
      for (let i = 0; i < updates.length; i += UPDATE_CONCURRENCY) {
        const slice = updates.slice(i, i + UPDATE_CONCURRENCY);
        await Promise.all(
          slice.map(({ id, set }) => db.update(entries).set(set).where(eq(entries.id, id)))
        );
      }
    }

    updated += updates.length;
    console.log(`  scanned=${scanned} updated=${updated} (cursor=${cursor})`);
  }

  console.log(
    DRY_RUN
      ? `Dry run complete. Would have updated ${updated} entries.`
      : `Done! Updated ${updated} entries.`
  );
}

main()
  .catch((err) => {
    console.error("Backfill failed:", err);
    process.exit(1);
  })
  .finally(() => pool.end());

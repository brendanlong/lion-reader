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
 * Each batch is written with one bulk `UPDATE ... FROM (VALUES ...)` per content
 * family rather than one statement per row, so a batch costs ~2 round trips
 * instead of ~BATCH_SIZE — the dominant saving when pointed at a remote DB.
 *
 * Optional env:
 *   BATCH_SIZE   rows fetched/updated per batch (default 50). Raw content can be
 *                ~700KB/field × 4 fields, so keep this modest to bound memory and
 *                per-statement payload size.
 */

import { drizzle } from "drizzle-orm/node-postgres";
import { and, asc, gt, isNotNull, ne, or, sql, type AnyColumn, type SQL } from "drizzle-orm";
import { Pool } from "pg";

import * as schema from "../src/server/db/schema";
import { entries } from "../src/server/db/schema";
import { SANITIZER_VERSION } from "../src/server/html/sanitize";
import { withSanitizedEntryContent } from "../src/server/html/sanitize-entry";

const DRY_RUN = process.argv.includes("--dry-run");
const BATCH_SIZE = Number(process.env.BATCH_SIZE ?? 50);

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

/** A row's freshly-sanitized values for one content family. */
interface FamilyUpdate {
  id: string;
  originalSanitized: string | null;
  cleanedSanitized: string | null;
}

/**
 * Apply one content family's sanitized columns to many rows in a single
 * statement: `UPDATE entries ... FROM (VALUES ...)`. This collapses what would
 * be one round trip per row into one per batch — the dominant saving when the
 * DB is remote. Only this family's three columns are touched, so a row that is
 * stale in only the other family is left alone. The id/text casts pin the VALUES
 * column types (otherwise a leading NULL would leave them `unknown`).
 */
async function bulkUpdateFamily(
  rows: FamilyUpdate[],
  originalCol: AnyColumn,
  cleanedCol: AnyColumn,
  versionCol: AnyColumn
): Promise<void> {
  if (rows.length === 0) return;

  const values = sql.join(
    rows.map(
      (r) => sql`(${r.id}::uuid, ${r.originalSanitized}::text, ${r.cleanedSanitized}::text)`
    ),
    sql`, `
  );

  await db.execute(sql`
    UPDATE ${entries} AS t
    SET ${sql.identifier(originalCol.name)} = v.original,
        ${sql.identifier(cleanedCol.name)} = v.cleaned,
        ${sql.identifier(versionCol.name)} = ${SANITIZER_VERSION}
    FROM (VALUES ${values}) AS v(id, original, cleaned)
    WHERE t.id = v.id
  `);
}

async function main() {
  console.log(
    `Backfilling sanitized entry content (SANITIZER_VERSION=${SANITIZER_VERSION}, batch=${BATCH_SIZE})${
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

    // Sanitize each stale family, collecting rows per family for a single bulk
    // UPDATE each. We still derive the sanitized values via the shared
    // `withSanitizedEntryContent` helper so the output is byte-identical to every
    // other write path (and the read-path heal).
    const contentRows: FamilyUpdate[] = [];
    const fullContentRows: FamilyUpdate[] = [];

    for (const row of batch) {
      const contentNeedsWork =
        row.contentSanitizedVersion !== SANITIZER_VERSION &&
        (row.contentOriginal !== null || row.contentCleaned !== null);
      if (contentNeedsWork) {
        const s = withSanitizedEntryContent({
          contentOriginal: row.contentOriginal,
          contentCleaned: row.contentCleaned,
        });
        contentRows.push({
          id: row.id,
          originalSanitized: s.contentOriginalSanitized ?? null,
          cleanedSanitized: s.contentCleanedSanitized ?? null,
        });
      }

      const fullContentNeedsWork =
        row.fullContentSanitizedVersion !== SANITIZER_VERSION &&
        (row.fullContentOriginal !== null || row.fullContentCleaned !== null);
      if (fullContentNeedsWork) {
        const s = withSanitizedEntryContent({
          fullContentOriginal: row.fullContentOriginal,
          fullContentCleaned: row.fullContentCleaned,
        });
        fullContentRows.push({
          id: row.id,
          originalSanitized: s.fullContentOriginalSanitized ?? null,
          cleanedSanitized: s.fullContentCleanedSanitized ?? null,
        });
      }
    }

    if (!DRY_RUN) {
      // Sequential (not parallel): a row stale in both families appears in both
      // lists, so concurrent UPDATEs could contend on the same row.
      await bulkUpdateFamily(
        contentRows,
        entries.contentOriginalSanitized,
        entries.contentCleanedSanitized,
        entries.contentSanitizedVersion
      );
      await bulkUpdateFamily(
        fullContentRows,
        entries.fullContentOriginalSanitized,
        entries.fullContentCleanedSanitized,
        entries.fullContentSanitizedVersion
      );
    }

    updated += batch.length;
    console.log(
      `  scanned=${scanned} updated=${updated} (content=${contentRows.length} full=${fullContentRows.length}, cursor=${cursor})`
    );
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

/**
 * Background re-sanitization of stored entry HTML.
 *
 * Sanitized entry HTML is persisted in the `entries.*_sanitized` columns and
 * stamped with the `SANITIZER_VERSION` it was produced with (see
 * `@/server/html/sanitize-entry`). When that version is bumped (the allow-list
 * or a pre-sanitization transform changed), every stored row with content
 * becomes stale. The read path re-sanitizes stale rows on demand and self-heals
 * (`resolveSanitizedFamily` in `@/server/services/entries`), but only for
 * entries someone actually opens — an entry nobody reads would stay stale
 * forever. This service is the sweeper that heals the rest in the background, a
 * small batch at a time, so the whole corpus converges to the current version
 * without a big migration or a read-time cost spike.
 *
 * The sweep is **stateless**: each batch just asks for the stalest rows and
 * heals them. Healed rows advance to the current version and drop out of the
 * "stale" range, so the next batch naturally resumes where this one left off —
 * no cursor to carry across runs. This works because the query is backed by
 * `idx_entries_resanitize`, an expression index over `RESANITIZE_STALENESS_KEY`
 * (DESC) then `id` (DESC).
 *
 * ## The staleness key
 *
 * Each entry has two independently-versioned content families — `content_*`
 * (always present) and `full_content_*` (only after a full-content fetch). A
 * family only needs re-sanitizing if it actually **has raw content**: a family
 * with no raw sanitizes to NULL regardless of version, so re-stamping it is
 * pure churn. Critically, ordinary feed/email writes never touch the
 * full-content columns, so `full_content_sanitized_version` is NULL for the vast
 * majority of rows — treating "NULL version" as stale would drag essentially the
 * entire table into the sweep forever (a one-time full rewrite plus a re-stamp
 * of every newly-inserted entry, never reaching idle).
 *
 * So `RESANITIZE_STALENESS_KEY` is the lower of the two families' *effective*
 * versions, where a family with no raw content contributes a large sentinel
 * (`RESANITIZE_NA` — bigger than any real version) so it can never make the row
 * stale, and a family with raw content contributes its version (NULL → -1, i.e.
 * "has content but never sanitized", genuinely stale). A row is stale iff this
 * key is `< SANITIZER_VERSION`.
 *
 * Ordering by that key `DESC` (then `id DESC`) makes the filter `key < V` a
 * single index range whose scan order already satisfies the ORDER BY, so
 * Postgres seeks past the fresh rows and reads only the batch — no full scan, no
 * sort. Bumping the version touches no rows: the same index serves the new pass
 * because only the query's `< V` bound moves up.
 *
 * The ordering relaxes strict newest-first to "highest stale version, then
 * newest id". Right after a bump that's a no-op — every stale row sits at the
 * previous version, the highest stale key, so it's pure newest-first. The
 * version tiebreak only reorders stragglers left by an unfinished earlier pass,
 * where order doesn't matter. See `handleResanitizeEntries` in
 * `src/server/jobs/handlers.ts` for scheduling.
 *
 * This module also exports `persistResanitizedFamily`, the guarded write shared
 * with the read-path self-heal (`resolveSanitizedFamily` in
 * `@/server/services/entries`) so both re-sanitization paths persist identically.
 */

import { and, desc, eq, sql } from "drizzle-orm";
import type { db as dbType } from "@/server/db";
import { entries } from "@/server/db/schema";
import { logger } from "@/lib/logger";
import { sanitizeEntryHtml, SANITIZER_VERSION } from "@/server/html/sanitize";

export interface ResanitizeBatchResult {
  /** Number of stale entries examined in this batch. */
  processed: number;
  /** How many entries had their `content_*` family re-sanitized. */
  contentResanitized: number;
  /** How many entries had their `full_content_*` family re-sanitized. */
  fullContentResanitized: number;
  /** How many entries threw while sanitizing and were skipped this batch. */
  failed: number;
}

/**
 * Sentinel "not applicable" version for a family with no raw content: larger
 * than any real `SANITIZER_VERSION` so such a family never makes a row stale.
 * MUST match the value in `idx_entries_resanitize` (migration 0085).
 */
const RESANITIZE_NA = 2147483647;

/**
 * Single orderable staleness key (see module doc): the lower of the two
 * families' effective versions, where a family with no raw content contributes
 * `RESANITIZE_NA` and one with raw content contributes its version (NULL → -1).
 * A row is stale iff this is `< SANITIZER_VERSION`.
 *
 * MUST stay structurally identical to the expression in `idx_entries_resanitize`
 * (migration 0085) — the planner only uses the index if the query's expression
 * matches it. The EXPLAIN assertion in the integration test guards this.
 */
export const RESANITIZE_STALENESS_KEY = sql<number>`LEAST(
  CASE WHEN ${entries.contentOriginal} IS NOT NULL OR ${entries.contentCleaned} IS NOT NULL
    THEN COALESCE(${entries.contentSanitizedVersion}, -1) ELSE ${RESANITIZE_NA} END,
  CASE WHEN ${entries.fullContentOriginal} IS NOT NULL OR ${entries.fullContentCleaned} IS NOT NULL
    THEN COALESCE(${entries.fullContentSanitizedVersion}, -1) ELSE ${RESANITIZE_NA} END
)`;

/**
 * Builds the "stalest rows first" query used by both the sweep and the EXPLAIN
 * test, so the test verifies the exact query the service runs. Selects each
 * family's content hash so the persist can guard against the raw changing under
 * us (see persistResanitizedFamily).
 */
export function selectStaleEntriesForResanitize(db: typeof dbType, limit: number) {
  return db
    .select({
      id: entries.id,
      contentOriginal: entries.contentOriginal,
      contentCleaned: entries.contentCleaned,
      contentSanitizedVersion: entries.contentSanitizedVersion,
      contentHash: entries.contentHash,
      fullContentOriginal: entries.fullContentOriginal,
      fullContentCleaned: entries.fullContentCleaned,
      fullContentSanitizedVersion: entries.fullContentSanitizedVersion,
      fullContentHash: entries.fullContentHash,
    })
    .from(entries)
    .where(sql`${RESANITIZE_STALENESS_KEY} < ${SANITIZER_VERSION}`)
    .orderBy(sql`${RESANITIZE_STALENESS_KEY} DESC`, desc(entries.id))
    .limit(limit);
}

/**
 * True when a content family's stored sanitized version is behind the current
 * `SANITIZER_VERSION` and so needs re-sanitizing. NULL means "has raw content but
 * was never sanitized" (genuinely stale). A version *greater* than the current
 * one — a row written by a newer release, e.g. during an expand/contract rollout
 * or after a rollback — is deliberately NOT stale: we must never downgrade it to
 * our older rules. Shared by the sweep and the bulk script so both gate the same.
 */
export function isSanitizedFamilyStale(version: number | null): boolean {
  return version === null || version < SANITIZER_VERSION;
}

/**
 * Persists re-sanitized output for one content family under a two-part
 * compare-and-swap guard. Shared by the background sweep and the read-path
 * self-heal (`resolveSanitizedFamily`) so both persist identically. Returns
 * whether the row was actually updated.
 *
 * The guard skips the write unless BOTH still hold:
 * - the stored version is still older than `SANITIZER_VERSION` (`version IS NULL
 *   OR version < SANITIZER_VERSION`). This is strictly-less-than, not
 *   `IS DISTINCT FROM`: a concurrent writer that already produced
 *   current-version output wins (equal → skip), and — crucially — a row already
 *   at a *newer* version than ours (a newer release wrote it during a rollout, or
 *   we're an old release running after a rollback) is left untouched rather than
 *   downgraded to our older sanitizer rules. NULL version means never-sanitized,
 *   so it counts as stale.
 * - `hash IS NOT DISTINCT FROM expectedHash` — the raw content is still the one
 *   we sanitized from. The content hash changes whenever the raw content changes
 *   (`updateEntryContent` / `persistFullContentResult` co-write it), so this
 *   closes the read→sanitize→write TOCTOU: if a writer swapped the raw content
 *   (e.g. an old-release worker during a version-bump rollout, stamping the
 *   previous version so the version guard alone wouldn't catch it), the hash no
 *   longer matches and we skip rather than pairing new raw with sanitized output
 *   of the old raw. `IS NOT DISTINCT FROM` so a NULL hash matches a NULL hash.
 */
export async function persistResanitizedFamily(
  db: typeof dbType,
  entryId: string,
  family: "content" | "fullContent",
  sanitized: { original: string | null; cleaned: string | null },
  expectedHash: string | null
): Promise<boolean> {
  const versionColumn =
    family === "content" ? entries.contentSanitizedVersion : entries.fullContentSanitizedVersion;
  const hashColumn = family === "content" ? entries.contentHash : entries.fullContentHash;
  const setValues =
    family === "content"
      ? {
          contentOriginalSanitized: sanitized.original,
          contentCleanedSanitized: sanitized.cleaned,
          contentSanitizedVersion: SANITIZER_VERSION,
        }
      : {
          fullContentOriginalSanitized: sanitized.original,
          fullContentCleanedSanitized: sanitized.cleaned,
          fullContentSanitizedVersion: SANITIZER_VERSION,
        };

  const updated = await db
    .update(entries)
    .set(setValues)
    .where(
      and(
        eq(entries.id, entryId),
        sql`(${versionColumn} IS NULL OR ${versionColumn} < ${SANITIZER_VERSION})`,
        sql`${hashColumn} IS NOT DISTINCT FROM ${expectedHash}`
      )
    )
    .returning({ id: entries.id });

  return updated.length > 0;
}

/**
 * Re-sanitizes up to `limit` of the stalest stored entries (see module doc).
 *
 * A family is healed only when it has raw content and its stored version is
 * behind — matching the staleness key, so every selected row heals at least one
 * family and then leaves the stale range (forward progress without a cursor).
 * Each family is re-derived from its raw columns and persisted with a
 * compare-and-swap guard (`version IS NULL OR version < SANITIZER_VERSION`),
 * exactly like the read-path self-heal in `resolveSanitizedFamily`: if a
 * concurrent writer (feed refresh, full-content fetch) already stored content at
 * or beyond the current version, our guard matches no row and we skip it, so a
 * value computed from now-stale raw HTML can never clobber newer content.
 *
 * Sanitizing is wrapped per row: a row whose HTML makes `sanitize-html` throw is
 * logged and skipped rather than failing the whole batch (which — since the
 * sweep is stalest-first and stateless — would otherwise wedge global progress
 * on one poison row). A persistently-failing row is retried on later runs; it is
 * already unreadable via the read path, so the warning is the signal to fix it.
 */
export async function resanitizeStaleEntries(
  db: typeof dbType,
  params: { limit: number }
): Promise<ResanitizeBatchResult> {
  const rows = await selectStaleEntriesForResanitize(db, params.limit);

  let contentResanitized = 0;
  let fullContentResanitized = 0;
  let failed = 0;

  // Heal each stale family independently, sequentially, to keep the load gentle
  // and avoid holding many connections. The families are versioned separately
  // (written at different times), so each carries its own CAS guard.
  for (const row of rows) {
    try {
      const contentHasRaw = row.contentOriginal !== null || row.contentCleaned !== null;
      if (contentHasRaw && isSanitizedFamilyStale(row.contentSanitizedVersion)) {
        const persisted = await persistResanitizedFamily(
          db,
          row.id,
          "content",
          {
            original: sanitizeEntryHtml(row.contentOriginal),
            cleaned: sanitizeEntryHtml(row.contentCleaned),
          },
          row.contentHash
        );
        if (persisted) contentResanitized++;
      }

      const fullHasRaw = row.fullContentOriginal !== null || row.fullContentCleaned !== null;
      if (fullHasRaw && isSanitizedFamilyStale(row.fullContentSanitizedVersion)) {
        const persisted = await persistResanitizedFamily(
          db,
          row.id,
          "fullContent",
          {
            original: sanitizeEntryHtml(row.fullContentOriginal),
            cleaned: sanitizeEntryHtml(row.fullContentCleaned),
          },
          row.fullContentHash
        );
        if (persisted) fullContentResanitized++;
      }
    } catch (error) {
      // One row's pathological HTML must not wedge the whole stateless sweep.
      failed++;
      logger.warn("Failed to re-sanitize entry; skipping", {
        entryId: row.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    processed: rows.length,
    contentResanitized,
    fullContentResanitized,
    failed,
  };
}

/**
 * Re-sanitization of stored entry HTML.
 *
 * Sanitized entry HTML is persisted in the `entries.*_sanitized` columns and
 * stamped with the `SANITIZER_VERSION` it was produced with (see
 * `@/server/html/sanitize-entry`). When that version is bumped (the allow-list
 * or a pre-sanitization transform changed), every stored row with content
 * becomes stale. Two paths converge stale rows back to the current version, and
 * both use the primitives in this module:
 *
 * - The **read-path self-heal** (`resolveSanitizedFamily` in
 *   `@/server/services/entries`) re-sanitizes any stale entry someone opens and
 *   persists via `persistResanitizedFamily`.
 * - The **manual bulk script** (`scripts/resanitize-bulk.ts`) pages the whole
 *   stale set via `selectStaleEntriesForResanitize` and heals it at full speed;
 *   run it (from a throwaway box) after a `SANITIZER_VERSION` bump to cover the
 *   long tail of entries nobody opens.
 *
 * There used to be a third path — a `resanitize_entries` background job that
 * trickled through the stale set on the worker — but it was too expensive in
 * database CPU relative to its value and was removed (issue #1116); the bulk
 * script is the deliberate, operator-driven replacement.
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
 * entire table into the stale set forever (a one-time full rewrite plus a
 * re-stamp of every newly-inserted entry, never reaching empty).
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
 * where order doesn't matter.
 */

import { and, desc, eq, sql } from "drizzle-orm";
import type { db as dbType } from "@/server/db";
import { entries } from "@/server/db/schema";
import { SANITIZER_VERSION } from "@/server/html/sanitize";
import { shouldMaterializeFullContentOriginal } from "@/server/html/sanitize-entry";

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
 * Builds the "stalest rows first" query shared by the bulk re-sanitize script
 * (`scripts/resanitize-bulk.ts`) and the EXPLAIN test, so both run the exact
 * query `idx_entries_resanitize` is designed for. Orders by the staleness key
 * `DESC` (then `id DESC`) under the `key < SANITIZER_VERSION` bound, which the
 * index serves as a single range seek — no full scan, no sort, even when only a
 * sparse scattering of rows is stale (the steady state between version bumps).
 *
 * Selects each family's content hash so the persist can guard against the raw
 * changing under us (see persistResanitizedFamily), plus the computed
 * `stalenessKey` so a paginating caller can build the next keyset cursor from the
 * last row. The optional `cursor` keyset-paginates *within* the stale range on
 * `(stalenessKey, id)` descending — used by the bulk script to walk the whole set
 * without re-fetching in-flight rows.
 */
export function selectStaleEntriesForResanitize(
  db: typeof dbType,
  limit: number,
  cursor?: { stalenessKey: number; id: string }
) {
  const staleFilter = sql`${RESANITIZE_STALENESS_KEY} < ${SANITIZER_VERSION}`;
  // Keyset over the index's own ordering `(key DESC, id DESC)`: rows strictly
  // "after" the cursor are those with a smaller key, or the same key and a
  // smaller id. Combined with staleFilter (a bound on the same leading indexed
  // expression) the planner still serves it from `idx_entries_resanitize`.
  const keysetFilter = cursor
    ? sql`(${RESANITIZE_STALENESS_KEY} < ${cursor.stalenessKey} OR (${RESANITIZE_STALENESS_KEY} = ${cursor.stalenessKey} AND ${entries.id} < ${cursor.id}))`
    : undefined;
  return db
    .select({
      id: entries.id,
      stalenessKey: RESANITIZE_STALENESS_KEY,
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
    .where(keysetFilter ? and(staleFilter, keysetFilter) : staleFilter)
    .orderBy(sql`${RESANITIZE_STALENESS_KEY} DESC`, desc(entries.id))
    .limit(limit);
}

/**
 * Sanitize one family's raw columns into the `{ original, cleaned }` shape
 * that `persistResanitizedFamily` persists, applying the lazy full-content
 * rule (`shouldMaterializeFullContentOriginal` in `@/server/html/sanitize-entry`):
 * for the full-content family, the original's sanitized copy is materialized
 * only when cleaned is NULL (i.e. only when original is the serving variant) —
 * when cleaned exists, original comes back NULL without paying the whole-page
 * sanitize. The content family always materializes both variants (the frontend
 * has a user-facing original/cleaned toggle for feed content).
 *
 * Shared by the read-path self-heal (`resolveSanitizedFamily`) and the bulk
 * re-sanitize script so both converge stale rows to the same lazy shape.
 * `sanitize` is injected so each caller uses its own execution strategy
 * (worker-pool offload on request paths).
 */
export async function sanitizeFamilyFromRaw(
  family: "content" | "fullContent",
  raw: { original: string | null; cleaned: string | null },
  sanitize: (html: string | null) => Promise<string | null>
): Promise<{ original: string | null; cleaned: string | null }> {
  const materializeOriginal =
    family === "content" || shouldMaterializeFullContentOriginal(raw.cleaned);
  const [original, cleaned] = await Promise.all([
    materializeOriginal ? sanitize(raw.original) : Promise.resolve<string | null>(null),
    sanitize(raw.cleaned),
  ]);
  return { original, cleaned };
}

/**
 * True when a content family's stored sanitized version is behind the current
 * `SANITIZER_VERSION` and so needs re-sanitizing. NULL means "has raw content but
 * was never sanitized" (genuinely stale). A version *greater* than the current
 * one — a row written by a newer release, e.g. during an expand/contract rollout
 * or after a rollback — is deliberately NOT stale: we must never downgrade it to
 * our older rules.
 */
export function isSanitizedFamilyStale(version: number | null): boolean {
  return version === null || version < SANITIZER_VERSION;
}

/**
 * Persists re-sanitized output for one content family under a two-part
 * compare-and-swap guard. Shared by the read-path self-heal
 * (`resolveSanitizedFamily`) and the bulk re-sanitize script so both persist
 * identically. Returns whether the row was actually updated.
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

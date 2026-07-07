-- Index backing the stateless `resanitize_entries` background sweep
-- (src/server/services/resanitize.ts).
--
-- The sweep heals entries whose stored sanitized version is behind
-- SANITIZER_VERSION, stalest-first. Staleness is the lower of the two content
-- families' *effective* versions: a family with no raw content contributes the
-- sentinel 2147483647 (so it can never make the row stale — most rows have no
-- full-content columns, and treating that NULL as stale would sweep the whole
-- table forever), and a family with raw content contributes its version (NULL,
-- i.e. never sanitized, → -1). A row is stale iff that key is < SANITIZER_VERSION.
-- Ordering by the key DESC (then id DESC) makes `key < V` a single index range
-- whose scan order already satisfies the ORDER BY, so the sweep seeks past the
-- fresh rows and reads only its batch — no full scan, no sort, and a version
-- bump touches no rows (only the query's `< V` bound moves). The expression here
-- MUST match RESANITIZE_STALENESS_KEY in resanitize.ts or the planner won't use it.
--
-- NOTE: on a large `entries` table, build this CONCURRENTLY out-of-band first
-- (CREATE INDEX CONCURRENTLY can't run inside the migration runner's
-- transaction); this IF NOT EXISTS statement then no-ops there and only builds
-- the index on databases that don't have it yet.

CREATE INDEX IF NOT EXISTS idx_entries_resanitize
  ON entries (
    LEAST(
      CASE WHEN content_original IS NOT NULL OR content_cleaned IS NOT NULL
        THEN COALESCE(content_sanitized_version, -1) ELSE 2147483647 END,
      CASE WHEN full_content_original IS NOT NULL OR full_content_cleaned IS NOT NULL
        THEN COALESCE(full_content_sanitized_version, -1) ELSE 2147483647 END
    ) DESC,
    id DESC
  );

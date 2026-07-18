-- Drop idx_entries_resanitize: sanitization is now per-read (issue #1282), so
-- the persisted sanitized columns are no longer written and nothing pages a
-- "stale sanitized rows" set anymore. The only query this index ever served was
-- the manual bulk re-sanitize script (scripts/resanitize-bulk.ts), which is
-- deleted in the same change. The read-path self-heal is gone too, so no running
-- code depends on this index.
--
-- Expand/contract: this is the code-stops-reading step. The previous release's
-- read-path heal never used this index (it does a point lookup by id), and its
-- bulk script is operator-run, not automatic — so dropping the index is safe
-- during a rollout/rollback. The `*_sanitized` columns themselves survive this
-- release for rollback safety — the previous release re-sanitizes from raw when
-- the stored version is NULL — and a later migration drops them once no deployed
-- code reads them. Dropping the index also removes its non-HOT write overhead on
-- every entry insert/update immediately.

DROP INDEX IF EXISTS idx_entries_resanitize;

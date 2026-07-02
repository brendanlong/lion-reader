-- Expression index on entries for the primary sort column used by entry list queries.
--
-- The visible_entries view sorts by COALESCE(published_at, fetched_at) DESC, id DESC.
-- Without this index, PostgreSQL must materialize and sort ALL matching rows before
-- returning the top N. With this index, the planner can use an index scan in sort
-- order and stop after finding enough rows (limit pushdown).
--
-- Measured improvement (10K entries): 16.6ms → 0.48ms for first page,
-- 15.5ms → 0.36ms for cursor-paginated pages.
--
-- This index was originally created manually on production with CREATE INDEX
-- CONCURRENTLY (which can't run inside the migration runner's per-migration
-- transaction) and the migration file was never journaled, so databases built
-- from the journal silently lacked it (issue #953). It is now journaled without
-- CONCURRENTLY — a plain CREATE INDEX is fine for fresh/small databases — and
-- IF NOT EXISTS makes it a no-op where the index already exists.

CREATE INDEX IF NOT EXISTS idx_entries_published_coalesce
ON entries ((COALESCE(published_at, fetched_at)) DESC, id DESC);

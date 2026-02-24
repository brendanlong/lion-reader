-- Expression index on entries for the primary sort column used by entry list queries.
--
-- The visible_entries view sorts by COALESCE(published_at, fetched_at) DESC, id DESC.
-- Without this index, PostgreSQL must materialize and sort ALL matching rows before
-- returning the top N. With this index, the planner can use an index scan in sort
-- order and stop after finding enough rows (limit pushdown).
--
-- Measured improvement (10K entries): 16.6ms → 0.48ms for first page,
-- 15.5ms → 0.36ms for cursor-paginated pages.

CREATE INDEX CONCURRENTLY idx_entries_published_coalesce
ON entries ((COALESCE(published_at, fetched_at)) DESC, id DESC);

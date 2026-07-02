-- Compound index on entries for per-feed sorted queries.
--
-- When filtering entries by feed_id (single subscription view), the global
-- expression index (idx_entries_published_coalesce) must scan entries across
-- all feeds in sort order, filtering out non-matching feed_ids. This compound
-- index lets the planner seek directly to the feed_id partition and scan in
-- sort order within it.
--
-- The global index remains the better choice for "all entries" queries that
-- don't filter by feed_id. Write overhead is minimal since entry inserts
-- only happen in the background worker.
--
-- Like 0071, this was originally applied manually with CREATE INDEX CONCURRENTLY
-- and never journaled (issue #953); journaled here without CONCURRENTLY (the
-- runner wraps each migration in a transaction) and with IF NOT EXISTS so it's
-- a no-op on databases where it already exists.

CREATE INDEX IF NOT EXISTS idx_entries_feed_published_coalesce
ON entries (feed_id, (COALESCE(published_at, fetched_at)) DESC, id DESC);

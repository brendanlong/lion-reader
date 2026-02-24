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

CREATE INDEX CONCURRENTLY idx_entries_feed_published_coalesce
ON entries (feed_id, (COALESCE(published_at, fetched_at)) DESC, id DESC);

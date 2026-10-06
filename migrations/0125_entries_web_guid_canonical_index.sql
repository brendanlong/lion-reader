-- Index the canonical guid of web entries on its own (issue #1861), so the
-- redirect-merge dedup in the fetch fanout (`createUserEntriesForFeed`) and
-- the subscribe-time populate (`populateInitialUserEntries`) can look up a
-- fetched entry's twins in other feeds (normally none) instead of walking each
-- subscriber's whole history. uq_entries_feed_guid_canonical leads with
-- feed_id, so it can't serve a lookup across feeds.
--
-- The expression must stay exactly canonicalGuidSql()'s (and the unique
-- index's), or the planner won't match it.
CREATE INDEX IF NOT EXISTS idx_entries_web_guid_canonical
  ON entries ((regexp_replace(guid, '^https?://', 'https://')))
  WHERE type = 'web';
--> statement-breakpoint
-- The planner ignores a partial index's expression statistics, so without
-- these it guesses that a canonical guid matches 0.5% of entries and keeps
-- walking the subscriber's history instead of using the index above.
CREATE STATISTICS IF NOT EXISTS entries_guid_canonical_stats
  ON (regexp_replace(guid, '^https?://', 'https://')) FROM entries;
--> statement-breakpoint
-- Build the statistics now rather than at the next autoanalyze.
ANALYZE entries;

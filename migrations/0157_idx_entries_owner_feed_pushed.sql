-- The pushed arm of currentEntryIdsSql (the subscribe populate and a poll's
-- disappeared check): entries a hub announced after the feed's last poll.
-- Partial, since only WebSub feeds' entries are ever pushed. Building it scans
-- entries while blocking writes to it; on production create it by hand first:
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_entries_owner_feed_pushed
--     ON entries (owner_feed_id, pushed_at) WHERE type = 'web' AND pushed_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_entries_owner_feed_pushed
  ON entries (owner_feed_id, pushed_at) WHERE type = 'web' AND pushed_at IS NOT NULL;

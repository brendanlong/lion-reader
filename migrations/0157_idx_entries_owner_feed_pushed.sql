-- The pushed arm of currentEntryIdsSql (the subscribe populate and a poll's
-- disappeared check): entries a hub announced after the feed's last poll.
-- Partial, since only WebSub feeds' entries are ever pushed. No row matches yet
-- (0156 just added the column), so the build is one scan of entries with no
-- sort; writes to entries wait for it.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_entries_owner_feed_pushed
  ON entries (owner_feed_id, pushed_at) WHERE type = 'web' AND pushed_at IS NOT NULL;

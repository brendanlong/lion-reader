-- All's and Starred's merged indexes (#2151; 0177 says why).
SET LOCAL lock_timeout = '5s';

CREATE INDEX IF NOT EXISTS idx_user_entries_visible_read_timeline
  ON user_entries (user_id, read, published_or_fetched_at DESC, entry_id DESC)
  WHERE starred OR active_memberships > 0;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_user_entries_visible_read_score
  ON user_entries (user_id, read, score DESC NULLS LAST, published_or_fetched_at DESC, entry_id DESC)
  WHERE starred OR active_memberships > 0;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_user_entries_starred_read_timeline
  ON user_entries (user_id, read, published_or_fetched_at DESC, entry_id DESC)
  WHERE starred;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_user_entries_starred_read_score
  ON user_entries (user_id, read, score DESC NULLS LAST, published_or_fetched_at DESC, entry_id DESC)
  WHERE starred;

-- tag_entries' merged indexes (#2151; 0177 says why).
SET LOCAL lock_timeout = '5s';

CREATE INDEX IF NOT EXISTS idx_tag_entries_read_timeline
  ON tag_entries (list_id, read, published_or_fetched_at DESC, entry_id DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_tag_entries_read_score
  ON tag_entries (list_id, read, score DESC NULLS LAST, published_or_fetched_at DESC, entry_id DESC);

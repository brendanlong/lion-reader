-- One index per sort with `read` in the key, replacing each full/unread pair
-- (#2151): an unread page is one range of it, a page of both states one range
-- per value. A later release drops the pairs. Build these CONCURRENTLY on
-- production first (migrations/CLAUDE.md).
SET LOCAL lock_timeout = '5s';

CREATE INDEX IF NOT EXISTS idx_subscription_entries_read_timeline
  ON subscription_entries (subscription_id, read, published_or_fetched_at DESC, entry_id DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_subscription_entries_read_score
  ON subscription_entries (subscription_id, read, score DESC NULLS LAST, published_or_fetched_at DESC, entry_id DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_subscription_entries_read_position
  ON subscription_entries (subscription_id, read, position, published_or_fetched_at, entry_id);

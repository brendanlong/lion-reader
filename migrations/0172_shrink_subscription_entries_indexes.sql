-- subscription_entries' unread indexes without spam (#2114, migration 0170
-- says why). 0173 drops what these replace.
SET LOCAL lock_timeout = '5s';

CREATE INDEX IF NOT EXISTS idx_subscription_entries_unread_timeline_new
  ON subscription_entries (subscription_id, published_or_fetched_at DESC, entry_id DESC)
  WHERE NOT read;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_subscription_entries_unread_score_new
  ON subscription_entries (subscription_id, score DESC NULLS LAST, published_or_fetched_at DESC, entry_id DESC)
  WHERE NOT read;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_subscription_entries_unread_position_new
  ON subscription_entries (subscription_id, position ASC NULLS LAST, published_or_fetched_at, entry_id)
  WHERE NOT read;

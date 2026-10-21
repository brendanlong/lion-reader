-- Score and position orders for every list the date indexes serve, with the
-- same predicates (#2064). Rows without a value sort after those with one in
-- both directions, so a page reads the valued range, then the NULL range,
-- each one index range: scanned forward or backward, an index serves the two
-- directions of its value, while the NULL range always reads newest first.
-- Every membership carries a position column, but only collections' are set.
SET LOCAL lock_timeout = '5s';

-- Every build's lock up front, in the lock order: taking each table's as its
-- first build starts deadlocks with a fan-out holding subscription_entries
-- and waiting on user_entries. Writes wait until the builds are done.
LOCK TABLE user_entries, subscription_entries, tag_entries IN SHARE MODE;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_user_entries_visible_score
  ON user_entries (user_id, score DESC NULLS LAST, published_or_fetched_at DESC, entry_id DESC)
  WHERE NOT is_spam AND (starred OR active_memberships > 0);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_user_entries_visible_unread_score
  ON user_entries (user_id, score DESC NULLS LAST, published_or_fetched_at DESC, entry_id DESC)
  WHERE NOT read AND NOT is_spam AND (starred OR active_memberships > 0);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_user_entries_starred_score
  ON user_entries (user_id, score DESC NULLS LAST, published_or_fetched_at DESC, entry_id DESC)
  WHERE starred;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_user_entries_starred_unread_score
  ON user_entries (user_id, score DESC NULLS LAST, published_or_fetched_at DESC, entry_id DESC)
  WHERE starred AND NOT read;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_subscription_entries_score
  ON subscription_entries (subscription_id, score DESC NULLS LAST, published_or_fetched_at DESC, entry_id DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_subscription_entries_unread_score
  ON subscription_entries (subscription_id, score DESC NULLS LAST, published_or_fetched_at DESC, entry_id DESC)
  WHERE NOT read AND NOT is_spam;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_subscription_entries_position
  ON subscription_entries (subscription_id, position ASC NULLS LAST, published_or_fetched_at, entry_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_subscription_entries_unread_position
  ON subscription_entries (subscription_id, position ASC NULLS LAST, published_or_fetched_at, entry_id)
  WHERE NOT read AND NOT is_spam;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_tag_entries_score
  ON tag_entries (list_id, score DESC NULLS LAST, published_or_fetched_at DESC, entry_id DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_tag_entries_unread_score
  ON tag_entries (list_id, score DESC NULLS LAST, published_or_fetched_at DESC, entry_id DESC)
  WHERE NOT read;

-- Smaller list indexes (#2114). Every list query applies visibility
-- (visible_entries), so its index needs no other predicate: a list hiding
-- spam filters it per row, and spam is rare. The score and position indexes
-- hold only rows with a value: a page reads the rows without one through the
-- list's timeline index.
--
-- 0171 and 0172 drop the indexes the merged ones replace. The previous
-- release still orders Recently Read and the ranked sorts' unvalued range as
-- only the old read_changed_at and full score/position indexes return them,
-- so those are dropped a release later (#2116).
SET LOCAL lock_timeout = '5s';

-- Every build's lock up front, in the lock order (migration 0169 says why).
LOCK TABLE user_entries, subscription_entries, tag_entries IN SHARE MODE;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_user_entries_visible_timeline_new
  ON user_entries (user_id, published_or_fetched_at DESC, entry_id DESC)
  WHERE starred OR active_memberships > 0;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_user_entries_visible_unread_timeline_new
  ON user_entries (user_id, published_or_fetched_at DESC, entry_id DESC)
  WHERE NOT read AND (starred OR active_memberships > 0);
--> statement-breakpoint
-- NULLS LAST: most rows were never read or unread, and Recently Read starts
-- from the newest change.
CREATE INDEX IF NOT EXISTS idx_user_entries_visible_read_changed
  ON user_entries (user_id, read_changed_at DESC NULLS LAST, entry_id DESC)
  WHERE starred OR active_memberships > 0;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_user_entries_visible_scored
  ON user_entries (user_id, score DESC NULLS LAST, published_or_fetched_at DESC, entry_id DESC)
  WHERE score IS NOT NULL AND (starred OR active_memberships > 0);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_user_entries_visible_unread_scored
  ON user_entries (user_id, score DESC NULLS LAST, published_or_fetched_at DESC, entry_id DESC)
  WHERE score IS NOT NULL AND NOT read AND (starred OR active_memberships > 0);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_user_entries_starred_scored
  ON user_entries (user_id, score DESC NULLS LAST, published_or_fetched_at DESC, entry_id DESC)
  WHERE score IS NOT NULL AND starred;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_user_entries_starred_unread_scored
  ON user_entries (user_id, score DESC NULLS LAST, published_or_fetched_at DESC, entry_id DESC)
  WHERE score IS NOT NULL AND starred AND NOT read;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_subscription_entries_unread_timeline_new
  ON subscription_entries (subscription_id, published_or_fetched_at DESC, entry_id DESC)
  WHERE NOT read;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_subscription_entries_scored
  ON subscription_entries (subscription_id, score DESC NULLS LAST, published_or_fetched_at DESC, entry_id DESC)
  WHERE score IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_subscription_entries_unread_scored
  ON subscription_entries (subscription_id, score DESC NULLS LAST, published_or_fetched_at DESC, entry_id DESC)
  WHERE score IS NOT NULL AND NOT read;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_subscription_entries_positioned
  ON subscription_entries (subscription_id, position ASC NULLS LAST, published_or_fetched_at, entry_id)
  WHERE position IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_subscription_entries_unread_positioned
  ON subscription_entries (subscription_id, position ASC NULLS LAST, published_or_fetched_at, entry_id)
  WHERE position IS NOT NULL AND NOT read;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_tag_entries_scored
  ON tag_entries (list_id, score DESC NULLS LAST, published_or_fetched_at DESC, entry_id DESC)
  WHERE score IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_tag_entries_unread_scored
  ON tag_entries (list_id, score DESC NULLS LAST, published_or_fetched_at DESC, entry_id DESC)
  WHERE score IS NOT NULL AND NOT read;

-- Smaller list indexes (#2114). Every list query applies visibility
-- (visible_entries), so its index needs no other predicate: a list hiding
-- spam filters it per row, and spam is rare. That merges the timeline and
-- unread indexes with their spam-free copies, and lets showSpam lists use the
-- score and position ones. 0171 drops what these replace; 0172 and 0173 do
-- the same for subscription_entries, one table per migration.
--
-- The previous release's Wallabag `archived` sort reads the plain
-- read_changed_at index, so that one is dropped a release later (#2116).
SET LOCAL lock_timeout = '5s';

CREATE INDEX IF NOT EXISTS idx_user_entries_visible_timeline_new
  ON user_entries (user_id, published_or_fetched_at DESC, entry_id DESC)
  WHERE starred OR active_memberships > 0;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_user_entries_visible_unread_timeline_new
  ON user_entries (user_id, published_or_fetched_at DESC, entry_id DESC)
  WHERE NOT read AND (starred OR active_memberships > 0);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_user_entries_visible_score_new
  ON user_entries (user_id, score DESC NULLS LAST, published_or_fetched_at DESC, entry_id DESC)
  WHERE starred OR active_memberships > 0;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_user_entries_visible_unread_score_new
  ON user_entries (user_id, score DESC NULLS LAST, published_or_fetched_at DESC, entry_id DESC)
  WHERE NOT read AND (starred OR active_memberships > 0);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_user_entries_recently_read_new
  ON user_entries (user_id, read_changed_at DESC, entry_id DESC)
  WHERE read_changed_at IS NOT NULL AND (starred OR active_memberships > 0);

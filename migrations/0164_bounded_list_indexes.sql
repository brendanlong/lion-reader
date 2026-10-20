-- A list page reads only the rows it can show (#2068): these carry the
-- predicates every default list query has, visibility (visible_entries) and
-- no spam, so an unread or All page no longer skips over spam and the rows of
-- feeds the user left. The plain timeline and `WHERE NOT read` indexes stay
-- for what doesn't apply both: showSpam lists, mark-all-read, the counters.
SET LOCAL lock_timeout = '5s';

CREATE INDEX IF NOT EXISTS idx_user_entries_visible_timeline
  ON user_entries (user_id, published_or_fetched_at DESC, entry_id DESC)
  WHERE NOT is_spam AND (starred OR active_memberships > 0);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_user_entries_visible_unread_timeline
  ON user_entries (user_id, published_or_fetched_at DESC, entry_id DESC)
  WHERE NOT read AND NOT is_spam AND (starred OR active_memberships > 0);
--> statement-breakpoint
-- Starred's default view is unread only. Starred rows are always visible.
CREATE INDEX IF NOT EXISTS idx_user_entries_starred_unread_timeline
  ON user_entries (user_id, published_or_fetched_at DESC, entry_id DESC)
  WHERE starred AND NOT read;
--> statement-breakpoint
-- Recently Read lists only visible, non-spam rows that have been read or
-- unread at some point.
CREATE INDEX IF NOT EXISTS idx_user_entries_recently_read
  ON user_entries (user_id, read_changed_at DESC, entry_id DESC)
  WHERE read_changed_at IS NOT NULL AND NOT is_spam AND (starred OR active_memberships > 0);
--> statement-breakpoint
DROP INDEX IF EXISTS idx_user_entries_read_changed_at;

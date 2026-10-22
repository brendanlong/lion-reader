-- Replaces the user_entries indexes migration 0170's merged ones supersede
-- (#2114). The previous release's date pages carry visibility, so the merged
-- ones serve them too. Its own transaction, after 0170 commits: upgrading
-- 0170's share locks to drop would deadlock with a writer holding row locks
-- and waiting on them, and holding this table's exclusive lock while waiting
-- on another table's could deadlock with a list read (0172).
SET LOCAL lock_timeout = '5s';

DROP INDEX IF EXISTS idx_user_entries_published_or_fetched;
--> statement-breakpoint
DROP INDEX IF EXISTS idx_user_entries_visible_timeline;
--> statement-breakpoint
DROP INDEX IF EXISTS idx_user_entries_unread_timeline;
--> statement-breakpoint
DROP INDEX IF EXISTS idx_user_entries_visible_unread_timeline;
--> statement-breakpoint
ALTER INDEX IF EXISTS idx_user_entries_visible_timeline_new
  RENAME TO idx_user_entries_visible_timeline;
--> statement-breakpoint
ALTER INDEX IF EXISTS idx_user_entries_visible_unread_timeline_new
  RENAME TO idx_user_entries_visible_unread_timeline;

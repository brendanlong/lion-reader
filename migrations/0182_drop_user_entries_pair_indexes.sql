-- 0179's indexes, keyed on read, replace each full/unread pair (#2151, #2154).
SET LOCAL lock_timeout = '5s';

DROP INDEX IF EXISTS idx_user_entries_visible_timeline;
--> statement-breakpoint
DROP INDEX IF EXISTS idx_user_entries_visible_unread_timeline;
--> statement-breakpoint
DROP INDEX IF EXISTS idx_user_entries_visible_score;
--> statement-breakpoint
DROP INDEX IF EXISTS idx_user_entries_visible_unread_score;
--> statement-breakpoint
DROP INDEX IF EXISTS idx_user_entries_starred_timeline;
--> statement-breakpoint
DROP INDEX IF EXISTS idx_user_entries_starred_unread_timeline;
--> statement-breakpoint
DROP INDEX IF EXISTS idx_user_entries_starred_score;
--> statement-breakpoint
DROP INDEX IF EXISTS idx_user_entries_starred_unread_score;

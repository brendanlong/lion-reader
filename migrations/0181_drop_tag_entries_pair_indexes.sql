-- 0178's indexes, keyed on read, replace each full/unread pair (#2151, #2154).
SET LOCAL lock_timeout = '5s';

DROP INDEX IF EXISTS idx_tag_entries_timeline;
--> statement-breakpoint
DROP INDEX IF EXISTS idx_tag_entries_unread_timeline;
--> statement-breakpoint
DROP INDEX IF EXISTS idx_tag_entries_score;
--> statement-breakpoint
DROP INDEX IF EXISTS idx_tag_entries_unread_score;

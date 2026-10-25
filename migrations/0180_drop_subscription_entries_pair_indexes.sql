-- 0177's indexes, keyed on read, replace each full/unread pair (#2151, #2154).
SET LOCAL lock_timeout = '5s';

DROP INDEX IF EXISTS idx_subscription_entries_timeline;
--> statement-breakpoint
DROP INDEX IF EXISTS idx_subscription_entries_unread_timeline;
--> statement-breakpoint
DROP INDEX IF EXISTS idx_subscription_entries_score;
--> statement-breakpoint
DROP INDEX IF EXISTS idx_subscription_entries_unread_score;
--> statement-breakpoint
DROP INDEX IF EXISTS idx_subscription_entries_position;
--> statement-breakpoint
DROP INDEX IF EXISTS idx_subscription_entries_unread_position;

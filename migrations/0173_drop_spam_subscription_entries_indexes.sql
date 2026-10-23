-- Replaces the spam-free unread membership indexes with migration 0172's,
-- which serve the previous release's queries too.
SET LOCAL lock_timeout = '5s';

DROP INDEX IF EXISTS idx_subscription_entries_unread_timeline;
--> statement-breakpoint
DROP INDEX IF EXISTS idx_subscription_entries_unread_score;
--> statement-breakpoint
DROP INDEX IF EXISTS idx_subscription_entries_unread_position;
--> statement-breakpoint
ALTER INDEX IF EXISTS idx_subscription_entries_unread_timeline_new
  RENAME TO idx_subscription_entries_unread_timeline;
--> statement-breakpoint
ALTER INDEX IF EXISTS idx_subscription_entries_unread_score_new
  RENAME TO idx_subscription_entries_unread_score;
--> statement-breakpoint
ALTER INDEX IF EXISTS idx_subscription_entries_unread_position_new
  RENAME TO idx_subscription_entries_unread_position;

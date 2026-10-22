-- Replaces the spam-free unread membership index with migration 0170's,
-- which serves the previous release's queries too. One table per
-- transaction, as 0171 says.
SET LOCAL lock_timeout = '5s';

DROP INDEX IF EXISTS idx_subscription_entries_unread_timeline;
--> statement-breakpoint
ALTER INDEX IF EXISTS idx_subscription_entries_unread_timeline_new
  RENAME TO idx_subscription_entries_unread_timeline;

-- Unused or redundant with idx_entries_owner_feed (#2157).
SET LOCAL lock_timeout = '5s';

DROP INDEX IF EXISTS idx_entries_owner_feed_updated_at;
--> statement-breakpoint
DROP INDEX IF EXISTS idx_entries_published_coalesce;
--> statement-breakpoint
DROP INDEX IF EXISTS idx_entries_type;
--> statement-breakpoint
DROP INDEX IF EXISTS idx_entries_owner_subscription_updated_at;
--> statement-breakpoint
DROP INDEX IF EXISTS idx_entries_owner_user_updated_at;
--> statement-breakpoint
DROP INDEX IF EXISTS idx_entries_owner_feed_published_coalesce;
--> statement-breakpoint
DROP INDEX IF EXISTS idx_entries_owner_feed_spam;

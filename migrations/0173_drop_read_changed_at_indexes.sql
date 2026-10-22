-- Recently Read and Wallabag's archived sort read migration 0170's
-- idx_user_entries_visible_read_changed since the previous release (#2116).
SET LOCAL lock_timeout = '5s';

DROP INDEX IF EXISTS idx_user_entries_read_changed_at;
--> statement-breakpoint
DROP INDEX IF EXISTS idx_user_entries_recently_read;

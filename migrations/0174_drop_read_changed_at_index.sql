-- Only the previous release's Wallabag `archived` sort read this; that sort
-- is gone (#2114, #2116).
SET LOCAL lock_timeout = '5s';

DROP INDEX IF EXISTS idx_user_entries_read_changed_at;

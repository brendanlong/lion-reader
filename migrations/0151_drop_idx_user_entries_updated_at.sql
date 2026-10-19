-- Sync, its cursors and Wallabag `since` seek idx_user_entries_changed_at
-- (0150); nothing seeks user_entries by updated_at any more, and every write
-- that moves it paid to maintain this index.
SET LOCAL lock_timeout = '5s';

DROP INDEX IF EXISTS idx_user_entries_updated_at;

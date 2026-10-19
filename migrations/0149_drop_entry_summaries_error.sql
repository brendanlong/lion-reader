-- Nothing reads or writes entry_summaries.error or error_at.
SET LOCAL lock_timeout = '5s';

ALTER TABLE entry_summaries DROP COLUMN IF EXISTS error, DROP COLUMN IF EXISTS error_at;

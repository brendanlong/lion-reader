-- Nothing reads feeds.next_fetch_at through an index (scheduling uses
-- jobs.next_run_at; the column is only displayed), and indexing it kept every
-- per-fetch feed update from being HOT.
SET LOCAL lock_timeout = '5s';

DROP INDEX IF EXISTS idx_feeds_next_fetch;

-- Getting Started onboarding article (issue #1397).
--
-- Records when the Getting Started saved article was inserted for a user. Set
-- once and never cleared, so unstarring or deleting the article does not bring
-- it back on the next signup-path/backfill run.
ALTER TABLE users ADD COLUMN IF NOT EXISTS getting_started_at timestamptz;
--> statement-breakpoint

-- Drives the backfill job's "who still needs one" scan. Partial, so it shrinks
-- to nothing as the backfill drains and costs nothing once every user is done.
CREATE INDEX IF NOT EXISTS idx_users_getting_started_pending
  ON users (id) WHERE getting_started_at IS NULL;
--> statement-breakpoint

-- Register the backfill_getting_started singleton job (fills the article in for
-- users who predate the feature, and retries anyone whose signup-path insert
-- failed).
DROP INDEX jobs_singleton_type_unique;
--> statement-breakpoint
CREATE UNIQUE INDEX jobs_singleton_type_unique ON jobs (type)
  WHERE type IN ('renew_websub', 'monitor_feed_health', 'cleanup', 'reconcile_counters', 'backfill_getting_started');

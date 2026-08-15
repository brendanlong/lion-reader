-- Register the monitor_backup_health singleton job.
--
-- Watches the Postgres base-backup catalog and alerts when no backup has
-- completed recently. Why this is needed at all: src/server/backup/health.ts.
--
-- Expand/contract safe: this only widens the partial index's predicate, so the
-- previous release (which never inserts this type) is unaffected, and a
-- rollback leaves at most one orphaned jobs row that nothing claims.
DROP INDEX jobs_singleton_type_unique;
--> statement-breakpoint
CREATE UNIQUE INDEX jobs_singleton_type_unique ON jobs (type)
  WHERE type IN ('renew_websub', 'monitor_feed_health', 'monitor_backup_health', 'cleanup', 'reconcile_counters', 'backfill_getting_started');

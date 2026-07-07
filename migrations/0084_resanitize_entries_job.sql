-- Support the new `resanitize_entries` singleton job.
--
-- Extend the singleton-uniqueness partial index so claimSingletonJob's
-- INSERT...catch race protection (and the "exactly one instance" invariant)
-- covers the new job type. See src/server/jobs/queue.ts (SINGLETON_JOB_TYPES)
-- and src/server/services/resanitize.ts.

DROP INDEX jobs_singleton_type_unique;

--> statement-breakpoint

CREATE UNIQUE INDEX jobs_singleton_type_unique ON jobs (type)
  WHERE type IN ('renew_websub', 'monitor_feed_health', 'cleanup', 'resanitize_entries');

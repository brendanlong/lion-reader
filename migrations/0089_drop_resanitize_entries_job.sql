-- Remove the `resanitize_entries` background job (issue #1116).
--
-- The sweep was paused in #1109 after it proved too expensive in database CPU,
-- and is now deleted entirely: the read-path self-heal re-sanitizes any entry
-- that is opened, and the manual bulk script (scripts/resanitize-bulk.ts)
-- covers the long tail after a SANITIZER_VERSION bump. `idx_entries_resanitize`
-- is kept — the bulk script's staleness query still uses it.
--
-- Backward-compatible: the previous release already had the type out of
-- SINGLETON_JOB_TYPES (paused), so its worker never claims or re-creates this
-- row, and narrowing the partial unique index doesn't affect the types it
-- still uses.

DELETE FROM jobs WHERE type = 'resanitize_entries';

--> statement-breakpoint

DROP INDEX jobs_singleton_type_unique;

--> statement-breakpoint

CREATE UNIQUE INDEX jobs_singleton_type_unique ON jobs (type)
  WHERE type IN ('renew_websub', 'monitor_feed_health', 'cleanup');

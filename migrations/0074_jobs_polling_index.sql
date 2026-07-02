-- Restore the jobs polling index (issue #953).
--
-- 0046_simplify_jobs.sql dropped the jobs.enabled column, which implicitly
-- dropped the old partial polling index (idx_jobs_polling ... WHERE enabled =
-- true). Since then every claim query — claimJob, claimFeedJob, and
-- claimSingletonJob run every ~5s by each worker — has been a sequential scan
-- + sort over a table that grows by one row per feed forever.
--
-- All three claim queries filter on type (equality or ANY) and next_run_at
-- (<= now) and order by next_run_at, so (type, next_run_at) serves them all
-- with an ordered index scan.

CREATE INDEX idx_jobs_polling ON jobs (type, next_run_at);

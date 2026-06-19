-- Enforce the "exactly one instance" invariant for singleton jobs.
--
-- claimSingletonJob (src/server/jobs/queue.ts) self-creates a singleton job row
-- when none exists, relying on a try/catch around the INSERT to absorb the race
-- where two workers both observe "no row exists". But there was no unique
-- constraint on jobs.type, so the INSERT never conflicted and two workers racing
-- during a deploy/canary rollover could each insert a row for the same singleton
-- type. This adds the partial unique index that makes the INSERT...catch work.
--
-- First collapse any duplicate singleton rows that may already exist (keeping the
-- oldest), otherwise the unique index creation would fail.

DELETE FROM public.jobs j
USING public.jobs keep
WHERE j.type IN ('renew_websub', 'monitor_feed_health')
  AND j.type = keep.type
  AND j.id > keep.id;

CREATE UNIQUE INDEX jobs_singleton_type_unique
  ON public.jobs (type)
  WHERE type IN ('renew_websub', 'monitor_feed_health');

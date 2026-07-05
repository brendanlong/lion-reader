-- Enforce one fetch_feed job per feed so concurrent subscribes can't create
-- duplicate fetch jobs (issue #952).
--
-- ensureFeedJob (src/server/jobs/queue.ts) used to UPDATE-by-feedId and then
-- plain-INSERT when no row matched. Two concurrent subscribes to the same feed
-- could both see no row and both INSERT, leaving two fetch_feed jobs for the
-- same feed that then fetch it twice every cycle forever. There was only a
-- non-unique index on (payload->>'feedId'), so nothing stopped the second
-- insert. This adds a partial UNIQUE index so ensureFeedJob can INSERT ... ON
-- CONFLICT instead.
--
-- First collapse any duplicate fetch_feed rows that already exist (keeping the
-- oldest by id), otherwise the unique index creation would fail.

DELETE FROM public.jobs j
USING public.jobs keep
WHERE j.type = 'fetch_feed'
  AND keep.type = 'fetch_feed'
  AND j.payload->>'feedId' = keep.payload->>'feedId'
  AND j.id > keep.id;

--> statement-breakpoint

-- The old non-unique index is now redundant: the unique index below covers the
-- same expression + predicate and serves the same feedId lookups.
DROP INDEX IF EXISTS idx_jobs_feed_id;

--> statement-breakpoint

CREATE UNIQUE INDEX idx_jobs_feed_id
  ON public.jobs ((payload->>'feedId'))
  WHERE type = 'fetch_feed';

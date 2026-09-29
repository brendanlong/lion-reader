-- At most one *pending* (never claimed) fetch_full_content job per feed, so a
-- WebSub push can append its entries to the feed's pending job with
-- INSERT ... ON CONFLICT instead of adding another job (see
-- enqueueFullContentFetch in src/server/jobs/queue.ts).
--
-- "Pending" is a positive payload marker, so the predicate excludes rows
-- written by the previous release (which never set it). Those can be several
-- per feed, and matching them would make the index build fail.
--
-- A row also leaves the index as soon as any worker claims it (running_since)
-- or has ever run it (last_run_at). The current claim clears the marker too,
-- but a previous-release worker's claim doesn't; without these conditions a
-- row it claimed would stay "pending" forever and absorb later pushes that
-- never run.

CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_full_content_pending_feed_id
  ON public.jobs ((payload->>'feedId'))
  WHERE type = 'fetch_full_content'
    AND (payload->>'pending') = 'true'
    AND running_since IS NULL
    AND last_run_at IS NULL;

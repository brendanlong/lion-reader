-- At most one *pending* (not yet claimed) fetch_full_content job per feed, so a
-- WebSub push can append its entries to the feed's pending job with
-- INSERT ... ON CONFLICT instead of adding another job (see
-- enqueueFullContentFetch in src/server/jobs/queue.ts).
--
-- "Pending" is a positive payload marker the claim removes, so the predicate
-- excludes rows written by the previous release (which never set it). Those can
-- be several per feed, and matching them would make the index build fail.

CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_full_content_pending_feed_id
  ON public.jobs ((payload->>'feedId'))
  WHERE type = 'fetch_full_content' AND (payload->>'pending') = 'true';

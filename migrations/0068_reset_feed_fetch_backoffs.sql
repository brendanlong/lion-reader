-- Reset feed fetch failure backoffs.
--
-- The SSRF protection change (PR #901) paired an npm-undici dispatcher with
-- Node's global fetch, which silently skips body decompression on Node 26.
-- Every compressed feed fetch since then failed with "Unknown feed format",
-- accumulating consecutive_failures and exponential backoff (up to 7 days).
-- PR #904 fixes the fetching; this migration clears the bogus failure state
-- so feeds recover promptly instead of waiting out their backoff.
--
-- Mirrors the per-feed "retry now" reset in brokenFeeds.retryFeed, applied in
-- bulk. Jobs are rescheduled over a 5-20 minute window rather than immediately:
-- migrations run before the new machines roll out, so an immediate run would
-- let old (still-broken) workers re-fail some feeds, and the spread avoids
-- refetching every feed at once.

UPDATE public.feeds
SET consecutive_failures = 0,
    last_error = NULL,
    next_fetch_at = now(),
    updated_at = now()
WHERE consecutive_failures > 0;

UPDATE public.jobs
SET consecutive_failures = 0,
    last_error = NULL,
    next_run_at = now() + interval '5 minutes' + random() * interval '15 minutes',
    updated_at = now()
WHERE type = 'fetch_feed'
  AND consecutive_failures > 0;

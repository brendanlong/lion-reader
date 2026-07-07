-- Per-hub push-reliability tally.
--
-- A WebSub hub can silently stop delivering while we still believe it's active
-- (Google's pubsubhubbub.appspot.com does exactly this). We can't act on a
-- single miss, but tallying per hub how new articles first reached us —
-- pushed by the hub, vs. first found by the 24h backup poll — lets us later
-- spot chronically-broken hubs.
--
-- articles_near_miss counts backup-poll discoveries that were published too
-- recently (or with an unknown date) to confidently blame the hub, so they
-- don't inflate the confirmed-miss count.
--
-- Purely observational: nothing reads these columns to change fetch behavior.
-- Expand-safe: brand-new table, no existing code depends on it.

CREATE TABLE public.websub_hub_stats (
    hub_url text PRIMARY KEY,
    articles_announced_by_hub bigint NOT NULL DEFAULT 0,
    articles_announced_by_backup bigint NOT NULL DEFAULT 0,
    articles_near_miss bigint NOT NULL DEFAULT 0,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now()
);

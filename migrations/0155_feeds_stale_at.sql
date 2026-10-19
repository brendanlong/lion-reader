-- When a feed's polled entries stop counting as current for a new subscriber:
-- its next poll by its own cadence, which for a WebSub feed is sooner than the
-- scheduled backup poll (shouldRefetchOnSubscribe). Seeded with what the
-- subscribe check used until now (the next poll, or an hour after a WebSub
-- feed's last poll) so the deploy doesn't force a refetch on every subscribe;
-- the previous release leaves it untouched, which only makes a feed stale
-- sooner.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE feeds ADD COLUMN stale_at timestamptz;
--> statement-breakpoint
UPDATE feeds
SET stale_at = CASE WHEN websub_active THEN last_fetched_at + interval '1 hour' ELSE next_fetch_at END;

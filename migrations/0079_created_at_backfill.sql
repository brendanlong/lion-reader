-- Add missing created_at columns to tables that lacked a creation timestamp
-- (issue #747). Most tables carry both created_at/updated_at, but a few junction
-- and event tables only had a domain-specific timestamp. This backfills a proper
-- creation timestamp so "row was created" is distinguishable from later mutations.
--
-- Covered here:
--   * blocked_senders   — had blocked_at (creation-equivalent), no created_at
--   * subscription_feeds — junction table, had neither
--
-- Not covered: user_entries.created_at was added in 0064; entry_score_predictions
-- was dropped in 0073.

-- ---------------------------------------------------------------------------
-- blocked_senders: backfill created_at from blocked_at (the row is created when
-- the sender is blocked, so they coincide for existing rows).
-- ---------------------------------------------------------------------------
ALTER TABLE blocked_senders ADD COLUMN created_at timestamptz;

--> statement-breakpoint

UPDATE blocked_senders SET created_at = blocked_at WHERE created_at IS NULL;

--> statement-breakpoint

ALTER TABLE blocked_senders ALTER COLUMN created_at SET NOT NULL;
ALTER TABLE blocked_senders ALTER COLUMN created_at SET DEFAULT NOW();

--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- subscription_feeds: backfill created_at from the later of the owning
-- subscription's created_at and the feed's created_at. The junction row is
-- created when a subscription first covers a feed, so it can't predate either;
-- redirect-added rows in particular point at a feed newer than the subscription.
-- Rows with no matching subscription/feed (shouldn't happen) fall back to NOW().
-- ---------------------------------------------------------------------------
ALTER TABLE subscription_feeds ADD COLUMN created_at timestamptz;

--> statement-breakpoint

UPDATE subscription_feeds sf
SET created_at = GREATEST(s.created_at, f.created_at)
FROM subscriptions s, feeds f
WHERE s.id = sf.subscription_id AND f.id = sf.feed_id AND sf.created_at IS NULL;

--> statement-breakpoint

UPDATE subscription_feeds SET created_at = NOW() WHERE created_at IS NULL;

--> statement-breakpoint

ALTER TABLE subscription_feeds ALTER COLUMN created_at SET NOT NULL;
ALTER TABLE subscription_feeds ALTER COLUMN created_at SET DEFAULT NOW();

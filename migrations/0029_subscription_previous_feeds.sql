-- Add previous_feed_ids array to track subscription migrations from feed redirects
-- and a generated feed_ids column that combines feed_id with previous_feed_ids for easier querying

ALTER TABLE subscriptions
ADD COLUMN previous_feed_ids uuid[] NOT NULL DEFAULT '{}';

--> statement-breakpoint

-- Generated column combining feed_id with previous_feed_ids for simpler join conditions
-- e.feed_id = ANY(s.feed_ids) instead of (s.feed_id = e.feed_id OR e.feed_id = ANY(s.previous_feed_ids))
ALTER TABLE subscriptions
ADD COLUMN feed_ids uuid[] GENERATED ALWAYS AS (
  ARRAY[feed_id] || previous_feed_ids
) STORED;

--> statement-breakpoint

-- Index on feed_ids for efficient ANY() lookups
CREATE INDEX idx_subscriptions_feed_ids ON subscriptions USING GIN (feed_ids);

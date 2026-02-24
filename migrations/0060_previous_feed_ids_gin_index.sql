-- Add GIN index on previous_feed_ids for efficient @> lookups in
-- redirect deduplication queries (entry-processor.ts).
CREATE INDEX idx_subscriptions_previous_feed_ids ON subscriptions USING GIN (previous_feed_ids);

-- Add redirect tracking fields to feeds table
-- Used to implement a wait period before applying permanent redirect migrations
-- redirect_url: The URL we're being redirected to (301/308)
-- redirect_first_seen_at: When we first observed this redirect

ALTER TABLE feeds
ADD COLUMN redirect_url text;

--> statement-breakpoint

ALTER TABLE feeds
ADD COLUMN redirect_first_seen_at timestamptz;

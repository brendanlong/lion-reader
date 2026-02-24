-- Add body_hash column to feeds table for detecting unchanged feed content
-- This allows skipping all processing when the feed body hasn't changed

ALTER TABLE feeds ADD COLUMN body_hash TEXT;

--> statement-breakpoint

-- Add comment explaining the column purpose
COMMENT ON COLUMN feeds.body_hash IS 'SHA-256 hash of raw feed body for change detection';

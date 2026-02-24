-- Add updated_at column to user_entries for tracking read/starred state changes
-- This enables the sync endpoint to query for entries with state changes since a timestamp

ALTER TABLE user_entries
ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

--> statement-breakpoint

-- Index for efficient sync queries: find all state changes for a user since a timestamp
CREATE INDEX idx_user_entries_updated_at
ON user_entries (user_id, updated_at);

-- Add columns for entry state update idempotency
-- These timestamps track when read/starred state was last set,
-- enabling conditional updates that only apply if the incoming change is newer.

ALTER TABLE user_entries
  ADD COLUMN read_changed_at timestamptz NOT NULL DEFAULT NOW(),
  ADD COLUMN starred_changed_at timestamptz NOT NULL DEFAULT NOW();

-- Add indexes for efficient conditional updates
-- These support the WHERE clause: read_changed_at < $changedAt
CREATE INDEX CONCURRENTLY idx_user_entries_read_changed_at
  ON user_entries (user_id, entry_id, read_changed_at);

CREATE INDEX CONCURRENTLY idx_user_entries_starred_changed_at
  ON user_entries (user_id, entry_id, starred_changed_at);

-- Add columns for entry state update idempotency
-- These timestamps track when read/starred state was last set,
-- enabling conditional updates that only apply if the incoming change is newer.

ALTER TABLE user_entries
  ADD COLUMN read_changed_at timestamptz NOT NULL DEFAULT NOW(),
  ADD COLUMN starred_changed_at timestamptz NOT NULL DEFAULT NOW();

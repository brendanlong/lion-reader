-- Add updated_at column to tags table for sync tracking
-- This allows detecting tag updates (name/color changes) and deletes

-- Add updated_at column with default value
ALTER TABLE tags
  ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Backfill existing rows with created_at value
UPDATE tags SET updated_at = created_at;

-- Add deleted_at column for soft deletes (enables detecting tag removal in sync)
ALTER TABLE tags
  ADD COLUMN deleted_at TIMESTAMPTZ;

-- Index for efficient sync queries (finding tags changed since cursor)
CREATE INDEX idx_tags_updated_at ON tags (user_id, updated_at);

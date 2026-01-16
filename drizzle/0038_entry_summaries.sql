-- Migration: Add AI summarization support
-- Creates entry_summaries table for caching AI-generated summaries
-- Uses content hash for deduplication across entries with identical content

-- Create entry_summaries table
CREATE TABLE entry_summaries (
  id uuid PRIMARY KEY NOT NULL,
  content_hash text UNIQUE NOT NULL,      -- SHA256 of source content

  summary_text text,                      -- null until generated
  model_id text,                          -- e.g., "claude-sonnet-4-20250514"
  prompt_version smallint NOT NULL DEFAULT 1,  -- for cache invalidation

  created_at timestamptz NOT NULL DEFAULT now(),
  generated_at timestamptz,               -- when summary was generated

  -- Error tracking for retry logic
  error text,
  error_at timestamptz
);

-- Index for identifying stale summaries (by prompt version)
CREATE INDEX idx_entry_summaries_prompt_version
  ON entry_summaries (prompt_version)
  WHERE summary_text IS NOT NULL;


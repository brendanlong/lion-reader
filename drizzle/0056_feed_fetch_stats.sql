-- Add feed fetch statistics columns to track per-fetch metrics.
-- These help monitor feed health and size over time.
ALTER TABLE feeds ADD COLUMN last_fetch_entry_count integer;
ALTER TABLE feeds ADD COLUMN last_fetch_size_bytes integer;
ALTER TABLE feeds ADD COLUMN total_entry_count integer NOT NULL DEFAULT 0;

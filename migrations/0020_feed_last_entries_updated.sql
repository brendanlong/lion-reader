-- Add last_entries_updated_at column to feeds table
-- This tracks when entries actually changed (new, updated, or removed from feed)
-- Unlike last_fetched_at which updates every fetch, this only updates when entries change
-- This ensures entries.last_seen_at matches feeds.last_entries_updated_at for current entries

ALTER TABLE feeds ADD COLUMN last_entries_updated_at timestamp with time zone;

--> statement-breakpoint

-- Backfill: for feeds that have been fetched, set last_entries_updated_at = last_fetched_at
-- This is a reasonable initial value since we don't have history of when entries actually changed
UPDATE feeds SET last_entries_updated_at = last_fetched_at WHERE last_fetched_at IS NOT NULL;

--> statement-breakpoint

-- Also update entries.last_seen_at to match feeds.last_entries_updated_at for consistency
-- This ensures the invariant: entries in current feed have last_seen_at = feeds.last_entries_updated_at
UPDATE entries e
SET last_seen_at = f.last_entries_updated_at
FROM feeds f
WHERE e.feed_id = f.id
  AND e.last_seen_at IS NOT NULL
  AND f.last_entries_updated_at IS NOT NULL
  AND e.last_seen_at = f.last_fetched_at;

--> statement-breakpoint

COMMENT ON COLUMN feeds.last_entries_updated_at IS 'Timestamp when entries last changed (new, updated, or removed). Matches entries.last_seen_at for current entries.';

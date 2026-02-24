-- Add last_seen_at to entries table for tracking which entries are in the current feed
-- This enables subscribing to an existing feed without re-fetching it.
--
-- For rss/atom/json entries: last_seen_at = feed.last_fetched_at means entry is in current feed
-- For email/saved entries: last_seen_at is always NULL (not applicable)

-- Step 1: Add the column (nullable initially for backfill)
ALTER TABLE "entries" ADD COLUMN "last_seen_at" timestamp with time zone;

-- Step 2: Backfill rss/atom/json entries with fetched_at
-- This assumes all existing entries were in the feed when they were last fetched
UPDATE "entries" SET "last_seen_at" = "fetched_at" WHERE "type" IN ('rss', 'atom', 'json');

-- Step 3: Add check constraint - last_seen_at required for fetched feeds, NULL for others
ALTER TABLE "entries" ADD CONSTRAINT "entries_last_seen_only_fetched"
  CHECK ((type IN ('rss', 'atom', 'json')) = (last_seen_at IS NOT NULL));

-- Step 4: Index for efficient visibility queries when subscribing
-- Only index feed types that use this field
CREATE INDEX "idx_entries_last_seen" ON "entries" ("feed_id", "last_seen_at")
  WHERE "type" IN ('rss', 'atom', 'json');

-- Migrate rss/atom/json feed types to 'web'
-- This consolidates the three URL-based feed types into a single type
-- since they're all handled the same way (fetch URL, auto-detect format)

-- Step 1: Drop the constraint that references old types FIRST
-- (must be done before updating entries, otherwise the constraint check fails)
ALTER TABLE "entries" DROP CONSTRAINT "entries_last_seen_only_fetched";

--> statement-breakpoint

-- Step 2: Drop the partial index that references old types
DROP INDEX IF EXISTS "idx_entries_last_seen";

--> statement-breakpoint

-- Step 3: Update all feeds with rss/atom/json type to 'web'
UPDATE "feeds" SET "type" = 'web' WHERE "type" IN ('rss', 'atom', 'json');

--> statement-breakpoint

-- Step 4: Update all entries with rss/atom/json type to 'web'
UPDATE "entries" SET "type" = 'web' WHERE "type" IN ('rss', 'atom', 'json');

--> statement-breakpoint

-- Step 5: Add the updated constraint using 'web' instead of rss/atom/json
ALTER TABLE "entries" ADD CONSTRAINT "entries_last_seen_only_fetched"
  CHECK ((type = 'web') = (last_seen_at IS NOT NULL));

--> statement-breakpoint

-- Step 6: Recreate the partial index using 'web'
CREATE INDEX "idx_entries_last_seen" ON "entries" ("feed_id", "last_seen_at")
  WHERE "type" = 'web';

-- Simplify user_entries: remove redundant timestamp columns and fix indexes
-- The starred_at/read_at timestamps duplicate the boolean flags and aren't used

-- Drop the useless duplicate index (duplicates PK)
DROP INDEX IF EXISTS "idx_user_entries_unread";--> statement-breakpoint

-- Drop the starred_at index (column is being removed)
DROP INDEX IF EXISTS "idx_user_entries_starred";--> statement-breakpoint

-- Remove redundant timestamp columns
ALTER TABLE "user_entries" DROP COLUMN IF EXISTS "read_at";--> statement-breakpoint
ALTER TABLE "user_entries" DROP COLUMN IF EXISTS "starred_at";--> statement-breakpoint

-- Index for joins from entries table (entries.list, entries.count queries)
-- Critical for: JOIN user_entries ON entry_id = entries.id
CREATE INDEX "idx_user_entries_entry_id" ON "user_entries" USING btree ("entry_id");--> statement-breakpoint

-- Partial index for unread entries (most common query pattern)
-- Used by: entries.list (unreadOnly), entries.count, subscriptions.list, tags.list
CREATE INDEX "idx_user_entries_unread" ON "user_entries" USING btree ("user_id") WHERE "read" = false;--> statement-breakpoint

-- Partial index for starred entries
-- Used by: entries.starredCount, entries.list (starredOnly)
CREATE INDEX "idx_user_entries_starred" ON "user_entries" USING btree ("user_id") WHERE "starred" = true;

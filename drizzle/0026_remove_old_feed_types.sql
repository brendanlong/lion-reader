-- Remove old feed_type enum values (rss, atom, json)
-- PostgreSQL doesn't support dropping enum values directly, so we:
-- 1. Drop constraints that reference the type column
-- 2. Create a new enum with only the values we want
-- 3. Change columns to use the new enum
-- 4. Drop the old enum
-- 5. Rename the new enum to the original name
-- 6. Recreate the constraints

-- Step 1: Drop constraints and indexes that reference the type column
ALTER TABLE "feeds" DROP CONSTRAINT IF EXISTS "feed_type_user_id";

--> statement-breakpoint

ALTER TABLE "entries" DROP CONSTRAINT IF EXISTS "entries_spam_only_email";

--> statement-breakpoint

ALTER TABLE "entries" DROP CONSTRAINT IF EXISTS "entries_unsubscribe_only_email";

--> statement-breakpoint

ALTER TABLE "entries" DROP CONSTRAINT IF EXISTS "entries_saved_metadata_only_saved";

--> statement-breakpoint

ALTER TABLE "entries" DROP CONSTRAINT IF EXISTS "entries_last_seen_only_fetched";

--> statement-breakpoint

-- Drop all indexes that reference the type column
DROP INDEX IF EXISTS "idx_entries_last_seen";

--> statement-breakpoint

DROP INDEX IF EXISTS "idx_entries_type";

--> statement-breakpoint

DROP INDEX IF EXISTS "idx_entries_feed_type";

--> statement-breakpoint

DROP INDEX IF EXISTS "idx_feeds_type";

--> statement-breakpoint

DROP INDEX IF EXISTS "uq_feeds_saved_user";

--> statement-breakpoint

-- Step 2: Create the new enum type with only the values we want
CREATE TYPE "public"."feed_type_new" AS ENUM('web', 'email', 'saved');

--> statement-breakpoint

-- Step 3: Change feeds.type to use the new enum
ALTER TABLE "feeds" ALTER COLUMN "type" TYPE "public"."feed_type_new" USING "type"::text::"public"."feed_type_new";

--> statement-breakpoint

-- Step 4: Change entries.type to use the new enum
ALTER TABLE "entries" ALTER COLUMN "type" TYPE "public"."feed_type_new" USING "type"::text::"public"."feed_type_new";

--> statement-breakpoint

-- Step 5: Drop the old enum type
DROP TYPE "public"."feed_type";

--> statement-breakpoint

-- Step 6: Rename the new enum to the original name
ALTER TYPE "public"."feed_type_new" RENAME TO "feed_type";

--> statement-breakpoint

-- Step 7: Recreate the constraints
ALTER TABLE "feeds" ADD CONSTRAINT "feed_type_user_id"
  CHECK ((type IN ('email', 'saved')) = (user_id IS NOT NULL));

--> statement-breakpoint

ALTER TABLE "entries" ADD CONSTRAINT "entries_spam_only_email"
  CHECK (type = 'email' OR (spam_score IS NULL AND is_spam = false));

--> statement-breakpoint

ALTER TABLE "entries" ADD CONSTRAINT "entries_unsubscribe_only_email"
  CHECK (type = 'email' OR (list_unsubscribe_mailto IS NULL AND list_unsubscribe_https IS NULL AND list_unsubscribe_post IS NULL));

--> statement-breakpoint

ALTER TABLE "entries" ADD CONSTRAINT "entries_saved_metadata_only_saved"
  CHECK (type = 'saved' OR (site_name IS NULL AND image_url IS NULL));

--> statement-breakpoint

ALTER TABLE "entries" ADD CONSTRAINT "entries_last_seen_only_fetched"
  CHECK ((type = 'web') = (last_seen_at IS NOT NULL));

--> statement-breakpoint

-- Step 8: Recreate the indexes
CREATE INDEX "idx_entries_last_seen" ON "entries" ("feed_id", "last_seen_at")
  WHERE "type" = 'web';

--> statement-breakpoint

CREATE INDEX "idx_entries_type" ON "entries" ("type");

--> statement-breakpoint

CREATE INDEX "idx_entries_feed_type" ON "entries" ("feed_id", "type");

--> statement-breakpoint

CREATE INDEX "idx_feeds_type" ON "feeds" ("type");

--> statement-breakpoint

CREATE UNIQUE INDEX "uq_feeds_saved_user" ON "feeds" ("user_id")
  WHERE "type" = 'saved';

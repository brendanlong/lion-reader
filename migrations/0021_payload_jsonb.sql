-- Convert jobs.payload from text to jsonb for better performance and simpler queries
-- All payloads are already valid JSON, so conversion is safe

-- Step 1: Drop the functional index that depends on the column
DROP INDEX IF EXISTS "idx_jobs_feed_id";--> statement-breakpoint

-- Step 2: Drop the default (text '{}' can't be auto-cast to jsonb)
ALTER TABLE "jobs" ALTER COLUMN "payload" DROP DEFAULT;--> statement-breakpoint

-- Step 3: Convert the column from text to jsonb
ALTER TABLE "jobs" ALTER COLUMN "payload" TYPE jsonb USING payload::jsonb;--> statement-breakpoint

-- Step 4: Set default to empty JSON object (jsonb literal)
ALTER TABLE "jobs" ALTER COLUMN "payload" SET DEFAULT '{}';--> statement-breakpoint

-- Step 5: Recreate the index without the ::json cast
CREATE INDEX "idx_jobs_feed_id" ON "jobs" USING btree ((payload->>'feedId')) WHERE "type" = 'fetch_feed';

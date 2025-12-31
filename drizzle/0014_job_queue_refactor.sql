-- Job queue refactor: one persistent job per feed instead of one job per fetch
-- See docs/job-queue-design.md for details

-- Step 1: Add new columns
ALTER TABLE "jobs" ADD COLUMN "enabled" boolean NOT NULL DEFAULT true;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "next_run_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "running_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "last_run_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "consecutive_failures" integer NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "updated_at" timestamp with time zone NOT NULL DEFAULT now();--> statement-breakpoint

-- Step 2: Migrate data - copy scheduled_for to next_run_at for pending jobs
UPDATE "jobs" SET "next_run_at" = "scheduled_for" WHERE "status" = 'pending';--> statement-breakpoint

-- Step 3: For fetch_feed jobs, keep only the earliest pending one per feed
-- First, delete all non-pending jobs (completed, failed, running)
DELETE FROM "jobs" WHERE "status" != 'pending';--> statement-breakpoint

-- Then delete duplicate fetch_feed jobs, keeping only the earliest per feedId
DELETE FROM "jobs" WHERE "type" = 'fetch_feed' AND "id" NOT IN (
  SELECT DISTINCT ON (payload::json->>'feedId') id
  FROM "jobs"
  WHERE "type" = 'fetch_feed'
  ORDER BY payload::json->>'feedId', "next_run_at" ASC NULLS LAST
);--> statement-breakpoint

-- Step 4: Drop old columns
ALTER TABLE "jobs" DROP COLUMN "status";--> statement-breakpoint
ALTER TABLE "jobs" DROP COLUMN "scheduled_for";--> statement-breakpoint
ALTER TABLE "jobs" DROP COLUMN "started_at";--> statement-breakpoint
ALTER TABLE "jobs" DROP COLUMN "completed_at";--> statement-breakpoint
ALTER TABLE "jobs" DROP COLUMN "attempts";--> statement-breakpoint
ALTER TABLE "jobs" DROP COLUMN "max_attempts";--> statement-breakpoint

-- Step 5: Drop job_status enum
DROP TYPE "job_status";--> statement-breakpoint

-- Step 6: Drop old indexes
DROP INDEX IF EXISTS "idx_jobs_pending";--> statement-breakpoint
DROP INDEX IF EXISTS "idx_jobs_status";--> statement-breakpoint

-- Step 7: Create new indexes
CREATE INDEX "idx_jobs_polling" ON "jobs" USING btree ("next_run_at") WHERE "enabled" = true;--> statement-breakpoint
CREATE INDEX "idx_jobs_feed_id" ON "jobs" USING btree ((payload::json->>'feedId')) WHERE "type" = 'fetch_feed';

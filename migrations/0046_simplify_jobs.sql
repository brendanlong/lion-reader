-- Remove the enabled column from jobs table
-- Jobs are now claimed based on data state, not an enabled flag

ALTER TABLE "jobs" DROP COLUMN IF EXISTS "enabled";

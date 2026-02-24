-- Add new enum values for feed types
-- IMPORTANT: Enum additions must be in their own migration because PostgreSQL
-- doesn't allow using new enum values in the same transaction they were added.
ALTER TYPE "public"."feed_type" ADD VALUE 'email';--> statement-breakpoint
ALTER TYPE "public"."feed_type" ADD VALUE 'saved';

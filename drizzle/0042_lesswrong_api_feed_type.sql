-- Add 'lesswrong' to the feed_type enum
ALTER TYPE "public"."feed_type" ADD VALUE 'lesswrong';

-- Add api_cursor column for API-based feeds to track pagination state
ALTER TABLE "feeds" ADD COLUMN "api_cursor" text;

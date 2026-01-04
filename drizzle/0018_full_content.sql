-- Add full content fetching capability for entries
-- This allows fetching the full article content from the article URL using Readability

-- Add columns to entries table for storing fetched full content
ALTER TABLE "entries" ADD COLUMN IF NOT EXISTS "content_full" text;
ALTER TABLE "entries" ADD COLUMN IF NOT EXISTS "content_full_fetched_at" timestamptz;
ALTER TABLE "entries" ADD COLUMN IF NOT EXISTS "content_full_error" text;

--> statement-breakpoint

-- Add column to subscriptions table for the per-subscription setting
ALTER TABLE "subscriptions" ADD COLUMN IF NOT EXISTS "fetch_full_content" boolean NOT NULL DEFAULT false;

-- Add 'web' to feed_type enum
-- This is a preparatory step before migrating rss/atom/json to 'web'
-- Per PostgreSQL rules, new enum values cannot be used in the same transaction they're added

ALTER TYPE "public"."feed_type" ADD VALUE 'web';

-- Add fetch_version column to feeds table.
-- This allows us to invalidate cached content when we improve the RSS parser or cleaning pipeline.
-- When fetch_version doesn't match CURRENT_FETCH_VERSION, we skip etag/body hash caching
-- and refetch/reparse the feed.
--
-- Migration sets all existing feeds to version 1.
-- CURRENT_FETCH_VERSION is set to 2, so all existing feeds will be refetched once.

ALTER TABLE feeds ADD COLUMN fetch_version INTEGER NOT NULL DEFAULT 1;

--> statement-breakpoint

COMMENT ON COLUMN feeds.fetch_version IS 'Version of fetch/parse logic; when below CURRENT_FETCH_VERSION, feed is refetched without cache';

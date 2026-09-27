-- Persist the feed-declared polling hints (RSS <ttl>, sy:updatePeriod /
-- sy:updateFrequency) so a 304 or an unchanged body — which skip parsing — can
-- still schedule from them instead of reverting to the default (issue #1547).
--
-- Additive nullable columns → expand/contract-compatible: the previous release
-- ignores them.
ALTER TABLE feeds ADD COLUMN IF NOT EXISTS ttl_minutes integer;
ALTER TABLE feeds ADD COLUMN IF NOT EXISTS syndication_update_period text;
ALTER TABLE feeds ADD COLUMN IF NOT EXISTS syndication_update_frequency integer;

-- Backfill by forcing one full parse per feed: a quiet feed answers every
-- conditional GET with a 304 and would otherwise never be parsed again to fill
-- the columns. Dropping the validators costs each feed one unconditional fetch
-- on its normal schedule; re-processing an unchanged feed doesn't churn entries.
UPDATE feeds
SET etag = NULL, last_modified_header = NULL, body_hash = NULL
WHERE url IS NOT NULL
  AND (etag IS NOT NULL OR last_modified_header IS NOT NULL OR body_hash IS NOT NULL);

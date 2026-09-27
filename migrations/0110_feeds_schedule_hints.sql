-- Persist the feed-declared polling hints (RSS <ttl>, sy:updatePeriod /
-- sy:updateFrequency) so a 304 or an unchanged body — which skip parsing — can
-- still schedule from them instead of reverting to the default (issue #1547).
--
-- Additive nullable columns → expand/contract-compatible: the previous release
-- ignores them. No backfill: each feed's next full parse fills them in.
ALTER TABLE feeds ADD COLUMN IF NOT EXISTS ttl_minutes integer;
ALTER TABLE feeds ADD COLUMN IF NOT EXISTS syndication_update_period text;
ALTER TABLE feeds ADD COLUMN IF NOT EXISTS syndication_update_frequency integer;

-- Entry writes a hub pushed that we dropped because the feed was over its push
-- budget (#2254).
ALTER TABLE websub_hub_stats ADD COLUMN articles_rate_limited bigint NOT NULL DEFAULT 0;

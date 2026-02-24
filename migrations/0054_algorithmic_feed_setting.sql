-- Add algorithmic_feed_enabled preference to users table.
-- When disabled, score models are not trained, the algorithmic feed is hidden,
-- and vote controls are not shown. Defaults to true (enabled).
ALTER TABLE users ADD COLUMN algorithmic_feed_enabled boolean NOT NULL DEFAULT true;

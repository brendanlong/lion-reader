-- Every feed is a web feed (#1846): this release's inserts stop naming
-- feeds.type, which #1846 phase 7B drops, so it defaults to 'web' until then.
-- Catalog only.
SET LOCAL lock_timeout = '5s';
ALTER TABLE feeds ALTER COLUMN type SET DEFAULT 'web';

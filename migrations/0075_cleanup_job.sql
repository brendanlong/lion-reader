-- Support the new `cleanup` singleton job (issue #953).
--
-- 1. Extend the singleton-uniqueness partial index so claimSingletonJob's
--    INSERT...catch race protection covers the new job type.
--
-- 2. Make oauth_refresh_tokens.replaced_by_id ON DELETE SET NULL. The rotation
--    chain FK previously had no ON DELETE action, so deleting an expired token
--    that a surviving (older) token still points at would fail; the cleanup
--    job deletes expired/long-revoked refresh tokens in bulk.

DROP INDEX jobs_singleton_type_unique;

--> statement-breakpoint

CREATE UNIQUE INDEX jobs_singleton_type_unique ON jobs (type)
  WHERE type IN ('renew_websub', 'monitor_feed_health', 'cleanup');

--> statement-breakpoint

ALTER TABLE oauth_refresh_tokens
  DROP CONSTRAINT oauth_refresh_tokens_replaced_by_id_fkey;

--> statement-breakpoint

ALTER TABLE oauth_refresh_tokens
  ADD CONSTRAINT oauth_refresh_tokens_replaced_by_id_fkey
  FOREIGN KEY (replaced_by_id) REFERENCES oauth_refresh_tokens(id) ON DELETE SET NULL;

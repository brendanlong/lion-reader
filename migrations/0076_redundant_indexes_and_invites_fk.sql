-- Drop redundant indexes and add the missing invites FK (issue #953).
--
-- Every token table carried both a UNIQUE constraint and a duplicate plain
-- index on the same column — pure write amplification, the unique index
-- already serves lookups. idx_subscriptions_user and idx_tags_user are
-- prefixes of their tables' composite UNIQUE constraints, and
-- idx_narration_needs_generation indexes the primary-key column.

DROP INDEX idx_sessions_token; -- duplicate of sessions_token_hash_unique

--> statement-breakpoint

DROP INDEX idx_api_tokens_token; -- duplicate of api_tokens_token_hash_key

--> statement-breakpoint

DROP INDEX idx_oauth_access_tokens_token; -- duplicate of oauth_access_tokens_token_hash_key

--> statement-breakpoint

DROP INDEX idx_oauth_refresh_tokens_token; -- duplicate of oauth_refresh_tokens_token_hash_key

--> statement-breakpoint

DROP INDEX idx_oauth_auth_codes_code; -- duplicate of oauth_authorization_codes_code_hash_key

--> statement-breakpoint

DROP INDEX idx_oauth_clients_client_id; -- duplicate of oauth_clients_client_id_key

--> statement-breakpoint

DROP INDEX idx_ingest_addresses_token; -- duplicate of ingest_addresses_token_unique

--> statement-breakpoint

DROP INDEX idx_invites_token; -- duplicate of invites_token_unique

--> statement-breakpoint

DROP INDEX idx_subscriptions_user; -- prefix of uq_subscriptions_user_feed

--> statement-breakpoint

DROP INDEX idx_tags_user; -- prefix of uq_tags_user_name

--> statement-breakpoint

DROP INDEX idx_narration_needs_generation; -- indexed the primary-key column

--> statement-breakpoint

-- invites.used_by_user_id had no foreign key; user deletion (see
-- deleteUser in src/server/services/users.ts) expects it to null out.
-- Null out any references already left dangling by past user deletions so
-- the constraint validates.
UPDATE invites SET used_by_user_id = NULL
WHERE used_by_user_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM users WHERE users.id = invites.used_by_user_id);

--> statement-breakpoint

ALTER TABLE invites
  ADD CONSTRAINT invites_used_by_user_id_fkey
  FOREIGN KEY (used_by_user_id) REFERENCES users(id) ON DELETE SET NULL;

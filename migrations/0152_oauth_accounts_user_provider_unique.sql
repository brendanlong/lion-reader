-- One link per provider per user (#2017). Production had no duplicates when this
-- shipped, and the table is small, so a plain build holds its lock only briefly.
-- The constraint's index leads with user_id, so it replaces idx_oauth_accounts_user.
SET LOCAL lock_timeout = '5s';

ALTER TABLE oauth_accounts
  ADD CONSTRAINT uq_oauth_accounts_user_provider UNIQUE (user_id, provider);

DROP INDEX IF EXISTS idx_oauth_accounts_user;

-- One link per provider per user (#2017). Links created before attaches locked
-- the user row can be duplicated; keep the oldest, the one attachOAuthAccount
-- used to refresh. The constraint's index leads with user_id, so it replaces
-- idx_oauth_accounts_user.
SET LOCAL lock_timeout = '5s';

DELETE FROM oauth_accounts
WHERE id NOT IN (
  SELECT DISTINCT ON (user_id, provider) id
  FROM oauth_accounts
  ORDER BY user_id, provider, created_at, id
);

ALTER TABLE oauth_accounts
  ADD CONSTRAINT uq_oauth_accounts_user_provider UNIQUE (user_id, provider);

DROP INDEX IF EXISTS idx_oauth_accounts_user;

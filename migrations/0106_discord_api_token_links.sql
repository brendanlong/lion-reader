-- Durable home for the Discord bot's API-token account links (#1370).
--
-- The Discord-user -> Lion Reader API-token linkage used to live only in Redis
-- (`discord:token:{discordId}`), which the deploy-time cache clear
-- (scripts/migrate.ts) wiped on every release, silently un-linking users who
-- linked via `/link` (OAuth-linked users were unaffected — that lives in
-- oauth_accounts). Move it to Postgres so it survives deploys and any Redis
-- data loss.
--
-- We store a reference to the api_tokens row rather than the raw token string:
-- no secret is kept at rest, and the link auto-invalidates (ON DELETE CASCADE)
-- when the token row is hard-deleted by retention. Revocation/expiry (soft
-- state on the token row) is still checked at resolve time.
--
-- One link per Discord user (discord_id PK); re-running `/link` upserts.
CREATE TABLE discord_api_token_links (
    discord_id text PRIMARY KEY,
    token_id uuid NOT NULL REFERENCES api_tokens(id) ON DELETE CASCADE,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

-- Index the FK so the api_tokens cascade delete doesn't seq-scan this table.
CREATE INDEX idx_discord_api_token_links_token ON discord_api_token_links (token_id);

-- API tokens table for extension and third-party integrations
-- Tokens are scoped to specific permissions (e.g., 'saved:write' for saving articles)
-- Token is stored as SHA-256 hash (never raw), similar to sessions

CREATE TABLE api_tokens (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text UNIQUE NOT NULL,

  -- Scopes define what this token can do (e.g., ['saved:write'])
  scopes text[] NOT NULL DEFAULT '{}',

  -- Optional name for user to identify the token
  name text,

  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  revoked_at timestamptz,
  last_used_at timestamptz
);

--> statement-breakpoint

CREATE INDEX idx_api_tokens_user ON api_tokens(user_id);

--> statement-breakpoint

CREATE INDEX idx_api_tokens_token ON api_tokens(token_hash);

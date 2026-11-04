-- Single-use links we email: verifying an account's address, and resetting its
-- password. Only the SHA-256 of a token is stored, like sessions.
CREATE TABLE email_tokens (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose text NOT NULL
    CONSTRAINT email_tokens_purpose_known CHECK (purpose IN ('verify_email', 'reset_password')),
  token_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

CREATE INDEX idx_email_tokens_user ON email_tokens (user_id);

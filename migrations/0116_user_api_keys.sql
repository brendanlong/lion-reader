-- Users' own AI provider keys, one row per provider, so adding a provider
-- needs no column. The old per-provider columns on users are copied here and
-- dropped in a later release, once nothing reads them.
CREATE TABLE IF NOT EXISTS user_api_keys (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider text NOT NULL,
  encrypted_key text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, provider)
);

INSERT INTO user_api_keys (user_id, provider, encrypted_key)
SELECT id, key.provider, key.encrypted_key
FROM users,
  LATERAL (VALUES
    ('anthropic', anthropic_api_key),
    ('groq', groq_api_key),
    ('cerebras', cerebras_api_key),
    ('openrouter', openrouter_api_key),
    ('deepinfra', deepinfra_api_key)
  ) AS key(provider, encrypted_key)
WHERE key.encrypted_key IS NOT NULL
ON CONFLICT DO NOTHING;

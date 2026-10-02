-- Last copy of the old per-provider key columns into user_api_keys, then
-- empty them. Until now, setting or removing a key also cleared its old
-- column, so a column that is still set holds either the key 0116 copied or
-- one the release before 0116 set afterwards: either way, the newest. From
-- this release on nothing writes the columns, so a later one can drop them.
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
ON CONFLICT (user_id, provider) DO UPDATE
  SET encrypted_key = EXCLUDED.encrypted_key, updated_at = now()
  WHERE user_api_keys.encrypted_key IS DISTINCT FROM EXCLUDED.encrypted_key;

UPDATE users SET
  anthropic_api_key = NULL,
  groq_api_key = NULL,
  cerebras_api_key = NULL,
  openrouter_api_key = NULL,
  deepinfra_api_key = NULL
WHERE anthropic_api_key IS NOT NULL
  OR groq_api_key IS NOT NULL
  OR cerebras_api_key IS NOT NULL
  OR openrouter_api_key IS NOT NULL
  OR deepinfra_api_key IS NOT NULL;

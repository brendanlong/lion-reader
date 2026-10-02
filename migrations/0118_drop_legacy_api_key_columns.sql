-- Users' API keys are in user_api_keys; 0117 copied and emptied these.
ALTER TABLE users
  DROP COLUMN IF EXISTS anthropic_api_key,
  DROP COLUMN IF EXISTS groq_api_key,
  DROP COLUMN IF EXISTS cerebras_api_key,
  DROP COLUMN IF EXISTS openrouter_api_key,
  DROP COLUMN IF EXISTS deepinfra_api_key;

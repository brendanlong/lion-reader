-- Per-user OpenRouter API key (encrypted like the other provider keys).
ALTER TABLE users ADD COLUMN IF NOT EXISTS openrouter_api_key text;

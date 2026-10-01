-- Per-user DeepInfra API key (encrypted like the other provider keys).
ALTER TABLE users ADD COLUMN IF NOT EXISTS deepinfra_api_key text;

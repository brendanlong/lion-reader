-- Add user-configurable API keys for Groq (narration) and Anthropic (summarization)
-- These override the global server keys when set.
ALTER TABLE users ADD COLUMN groq_api_key text;
ALTER TABLE users ADD COLUMN anthropic_api_key text;
ALTER TABLE users ADD COLUMN summarization_model text;

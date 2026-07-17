-- Generic AI provider support: per-user Cerebras API key and a narration
-- model setting. Model settings are stored as provider:model references
-- (e.g. 'groq:openai/gpt-oss-20b'); legacy bare summarization_model values
-- are parsed as Anthropic models.
ALTER TABLE users ADD COLUMN cerebras_api_key text;
ALTER TABLE users ADD COLUMN narration_model text;

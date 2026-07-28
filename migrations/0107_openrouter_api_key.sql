-- OpenRouter support for summaries and narration preprocessing (#1416).
-- One key reaches models from every major lab, so users don't need a separate
-- signup per provider. Model settings keep the same provider:model shape
-- (e.g. 'openrouter:openai/gpt-oss-120b').
ALTER TABLE users ADD COLUMN IF NOT EXISTS openrouter_api_key text;

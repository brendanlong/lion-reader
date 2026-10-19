-- Groq is no longer a provider: drop users' Groq keys, and send Groq model
-- choices back to the default (a "groq:" ref would otherwise parse as a bare
-- Anthropic model ID).
DELETE FROM user_api_keys WHERE provider = 'groq';

UPDATE users SET summarization_model = NULL WHERE summarization_model LIKE 'groq:%';

UPDATE users SET narration_model = NULL WHERE narration_model LIKE 'groq:%';

-- Add per-user summarization settings (max words and custom prompt)
-- These override the server defaults (SUMMARIZATION_MAX_WORDS env var and built-in prompt)
ALTER TABLE users ADD COLUMN summarization_max_words integer;
ALTER TABLE users ADD COLUMN summarization_prompt text;

-- Make entry_summaries per-user so different settings produce separate cached summaries
ALTER TABLE entry_summaries ADD COLUMN user_id uuid REFERENCES users(id) ON DELETE CASCADE;

-- Drop the old unique constraint on content_hash alone
ALTER TABLE entry_summaries DROP CONSTRAINT entry_summaries_content_hash_key;

-- Add a new unique constraint on (user_id, content_hash) for per-user caching
-- user_id can be null for legacy summaries generated before this migration
ALTER TABLE entry_summaries ADD CONSTRAINT entry_summaries_user_content_unique UNIQUE (user_id, content_hash);

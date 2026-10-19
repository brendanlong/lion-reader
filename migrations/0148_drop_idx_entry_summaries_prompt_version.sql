-- No query filters entry_summaries on prompt_version: a stale summary is
-- found by comparing the loaded row's prompt_version in application code.
SET LOCAL lock_timeout = '5s';

DROP INDEX IF EXISTS idx_entry_summaries_prompt_version;

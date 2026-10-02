-- The model and key a failed summary attempt ran on, so the error backoff can
-- let a request through once the user has changed either.
ALTER TABLE entry_summaries ADD COLUMN IF NOT EXISTS error_source text;

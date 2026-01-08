-- Add scopes tracking to oauth_accounts table for incremental authorization
-- This enables Phase 2 of Google Docs integration: private documents with user OAuth

ALTER TABLE oauth_accounts
ADD COLUMN scopes text[];

--> statement-breakpoint

-- Create GIN index for efficient scope lookups
CREATE INDEX idx_oauth_accounts_scopes ON oauth_accounts USING GIN (scopes);

--> statement-breakpoint

-- Populate existing Google OAuth accounts with current scopes
UPDATE oauth_accounts
SET scopes = ARRAY['openid', 'email', 'profile']
WHERE provider = 'google' AND scopes IS NULL;

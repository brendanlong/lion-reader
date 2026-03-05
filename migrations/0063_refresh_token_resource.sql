-- Add resource column to refresh tokens for RFC 8707 audience tracking.
-- This allows the resource binding to be preserved through token rotation.
ALTER TABLE oauth_refresh_tokens ADD COLUMN resource text;

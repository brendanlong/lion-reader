-- Make ingest_addresses.token case-insensitive using citext
-- This fixes a bug where tokens generated with mixed case couldn't be matched
-- because the lookup lowercases the token from the email address

-- Enable citext extension (safe to run multiple times)
CREATE EXTENSION IF NOT EXISTS citext;

--> statement-breakpoint

-- Convert existing tokens to lowercase and change column type to citext
-- The unique constraint will be automatically updated
ALTER TABLE ingest_addresses
  ALTER COLUMN token TYPE citext USING lower(token);

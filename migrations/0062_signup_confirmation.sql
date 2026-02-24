-- Add separate agreement tracking columns to users table.
-- Each column records when the user accepted a specific agreement.
-- All three must be non-null for the user to access the app.
ALTER TABLE users ADD COLUMN tos_agreed_at timestamptz;
ALTER TABLE users ADD COLUMN privacy_policy_agreed_at timestamptz;
ALTER TABLE users ADD COLUMN not_eu_agreed_at timestamptz;

-- Invite system for controlled signups
-- Invites are one-time use tokens that allow new users to register

-- Create invites table
CREATE TABLE IF NOT EXISTS "invites" (
  "id" uuid PRIMARY KEY NOT NULL,
  "token" text UNIQUE NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "used_at" timestamp with time zone,
  "used_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

-- Index for token lookup (most common query)
CREATE INDEX IF NOT EXISTS "idx_invites_token" ON "invites" ("token");

-- Index for finding expired/unused invites for cleanup
CREATE INDEX IF NOT EXISTS "idx_invites_expires" ON "invites" ("expires_at") WHERE "used_at" IS NULL;

-- Add invite_id to users table to track which invite was used
ALTER TABLE "users" ADD COLUMN "invite_id" uuid REFERENCES "invites"("id") ON DELETE SET NULL;

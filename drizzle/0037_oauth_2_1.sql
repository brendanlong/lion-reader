-- OAuth 2.1 Authorization Server Tables
-- Implements MCP-compliant OAuth 2.1 with PKCE, token rotation, and resource indicators

-- ============================================================================
-- OAuth Clients
-- ============================================================================

-- OAuth clients (Claude Desktop, other MCP clients)
-- Supports both registered clients and Client ID Metadata Documents (CIMD)
CREATE TABLE "oauth_clients" (
  "id" uuid PRIMARY KEY NOT NULL,
  "client_id" text UNIQUE NOT NULL,              -- URL for CIMD, or custom ID
  "client_secret_hash" text,                     -- NULL for public clients
  "name" text NOT NULL,
  "redirect_uris" text[] NOT NULL,               -- Allowed redirect URIs
  "grant_types" text[] NOT NULL DEFAULT '{authorization_code,refresh_token}',
  "scopes" text[],                               -- Available scopes for this client
  "is_public" boolean NOT NULL DEFAULT true,     -- PKCE required for public clients
  "metadata_url" text,                           -- For Client ID Metadata Documents
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX "idx_oauth_clients_client_id" ON "oauth_clients" ("client_id");

-- ============================================================================
-- Authorization Codes
-- ============================================================================

-- Short-lived authorization codes (~10 minutes)
-- Used in the OAuth authorization code flow with PKCE
CREATE TABLE "oauth_authorization_codes" (
  "id" uuid PRIMARY KEY NOT NULL,
  "code_hash" text UNIQUE NOT NULL,              -- SHA-256 hash of code (never store raw)
  "client_id" text NOT NULL,                     -- References oauth_clients.client_id
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "redirect_uri" text NOT NULL,                  -- Must match client's registered URIs
  "scopes" text[] NOT NULL,
  "code_challenge" text NOT NULL,                -- PKCE S256 hash
  "code_challenge_method" text NOT NULL DEFAULT 'S256',
  "resource" text,                               -- RFC 8707 resource indicator
  "state" text,                                  -- Client-provided state for CSRF
  "used_at" timestamptz,                         -- Codes are single-use
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "expires_at" timestamptz NOT NULL,

  -- Enforce S256 for PKCE (plain method is forbidden)
  CONSTRAINT "oauth_auth_codes_pkce_s256" CHECK ("code_challenge_method" = 'S256')
);

CREATE INDEX "idx_oauth_auth_codes_code" ON "oauth_authorization_codes" ("code_hash");
CREATE INDEX "idx_oauth_auth_codes_user" ON "oauth_authorization_codes" ("user_id");
CREATE INDEX "idx_oauth_auth_codes_expires" ON "oauth_authorization_codes" ("expires_at");

-- ============================================================================
-- Access Tokens
-- ============================================================================

-- Access tokens (short-lived, ~1 hour)
CREATE TABLE "oauth_access_tokens" (
  "id" uuid PRIMARY KEY NOT NULL,
  "token_hash" text UNIQUE NOT NULL,             -- SHA-256 hash of token
  "client_id" text NOT NULL,                     -- References oauth_clients.client_id
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "scopes" text[] NOT NULL,
  "resource" text,                               -- RFC 8707 audience
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "expires_at" timestamptz NOT NULL,
  "revoked_at" timestamptz,
  "last_used_at" timestamptz
);

CREATE INDEX "idx_oauth_access_tokens_token" ON "oauth_access_tokens" ("token_hash");
CREATE INDEX "idx_oauth_access_tokens_user" ON "oauth_access_tokens" ("user_id");
CREATE INDEX "idx_oauth_access_tokens_client" ON "oauth_access_tokens" ("client_id");
CREATE INDEX "idx_oauth_access_tokens_expires" ON "oauth_access_tokens" ("expires_at");

-- ============================================================================
-- Refresh Tokens
-- ============================================================================

-- Refresh tokens (longer-lived, ~30 days, with rotation)
CREATE TABLE "oauth_refresh_tokens" (
  "id" uuid PRIMARY KEY NOT NULL,
  "token_hash" text UNIQUE NOT NULL,             -- SHA-256 hash of token
  "client_id" text NOT NULL,                     -- References oauth_clients.client_id
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "scopes" text[] NOT NULL,
  "access_token_id" uuid REFERENCES "oauth_access_tokens"("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "expires_at" timestamptz NOT NULL,
  "revoked_at" timestamptz,
  "replaced_by_id" uuid REFERENCES "oauth_refresh_tokens"("id") -- Token rotation chain
);

CREATE INDEX "idx_oauth_refresh_tokens_token" ON "oauth_refresh_tokens" ("token_hash");
CREATE INDEX "idx_oauth_refresh_tokens_user" ON "oauth_refresh_tokens" ("user_id");
CREATE INDEX "idx_oauth_refresh_tokens_client" ON "oauth_refresh_tokens" ("client_id");
CREATE INDEX "idx_oauth_refresh_tokens_expires" ON "oauth_refresh_tokens" ("expires_at");
CREATE INDEX "idx_oauth_refresh_tokens_access" ON "oauth_refresh_tokens" ("access_token_id");

-- ============================================================================
-- Consent Grants
-- ============================================================================

-- Tracks user consent for OAuth clients (to avoid re-prompting)
CREATE TABLE "oauth_consent_grants" (
  "id" uuid PRIMARY KEY NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "client_id" text NOT NULL,                     -- References oauth_clients.client_id
  "scopes" text[] NOT NULL,                      -- Approved scopes
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "revoked_at" timestamptz,

  UNIQUE ("user_id", "client_id")
);

CREATE INDEX "idx_oauth_consent_grants_user" ON "oauth_consent_grants" ("user_id");
CREATE INDEX "idx_oauth_consent_grants_client" ON "oauth_consent_grants" ("client_id");

-- ============================================================================
-- Add to migration journal
-- ============================================================================
-- Run: pnpm drizzle-kit generate to update the journal

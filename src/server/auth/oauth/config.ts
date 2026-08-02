/**
 * OAuth Provider Configuration
 *
 * This module configures OAuth providers based on environment variables.
 * Providers are only enabled if their required credentials are set.
 *
 * Runtime Detection:
 * - Providers are automatically enabled/disabled based on env var presence
 * - UI can query /v1/auth/providers to know which buttons to show
 * - Self-hosters can omit OAuth config and still use email/password auth
 *
 * The client is `openid-client` (a certified OpenID Connect relying party, from the
 * author of `jose`). It hands back `Configuration` objects, which are what the
 * per-provider flow modules (`google.ts`, `apple.ts`, `discord.ts`) and the shared
 * `token-exchange.ts` operate on.
 */

import { importPKCS8, SignJWT } from "jose";
import * as client from "openid-client";

// ============================================================================
// Types
// ============================================================================

/**
 * Supported OAuth provider names
 */
export type OAuthProviderName = "google" | "apple" | "discord";

/**
 * Configuration for a single OAuth provider
 */
interface OAuthProviderConfig {
  enabled: boolean;
  clientId?: string;
  clientSecret?: string;
}

/**
 * Extended configuration for Apple OAuth
 * Apple requires additional keys for JWT signing
 */
interface AppleOAuthConfig extends OAuthProviderConfig {
  teamId?: string;
  keyId?: string;
  privateKey?: string;
}

// ============================================================================
// Authorization Server Metadata
// ============================================================================

/**
 * Authorization-server metadata is hard-coded rather than fetched with
 * `client.discovery()`: these endpoints are stable and published, and hard-coding keeps
 * a `.well-known` round-trip off the critical path of every login.
 *
 * `jwks_uri` only matters where the provider returns an `id_token` (Google, Apple);
 * Discord is plain OAuth 2 and issues none.
 */
const GOOGLE_SERVER: client.ServerMetadata = {
  issuer: "https://accounts.google.com",
  authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth",
  token_endpoint: "https://oauth2.googleapis.com/token",
  jwks_uri: "https://www.googleapis.com/oauth2/v3/certs",
};

const APPLE_SERVER: client.ServerMetadata = {
  issuer: "https://appleid.apple.com",
  authorization_endpoint: "https://appleid.apple.com/auth/authorize",
  token_endpoint: "https://appleid.apple.com/auth/token",
  jwks_uri: "https://appleid.apple.com/auth/keys",
};

const DISCORD_SERVER: client.ServerMetadata = {
  issuer: "https://discord.com",
  authorization_endpoint: "https://discord.com/oauth2/authorize",
  token_endpoint: "https://discord.com/api/oauth2/token",
};

// ============================================================================
// Environment Variables
// ============================================================================

/**
 * Google OAuth environment variables
 */
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;

/**
 * Apple OAuth environment variables
 * Note: Apple requires more complex setup with team ID, key ID, and private key
 */
const APPLE_CLIENT_ID = process.env.APPLE_CLIENT_ID;
const APPLE_TEAM_ID = process.env.APPLE_TEAM_ID;
const APPLE_KEY_ID = process.env.APPLE_KEY_ID;
const APPLE_PRIVATE_KEY = process.env.APPLE_PRIVATE_KEY;

/**
 * Discord OAuth environment variables
 */
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;

/**
 * Base URL for OAuth callbacks
 */
const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

// ============================================================================
// Provider Configurations
// ============================================================================

/**
 * Google OAuth provider configuration
 * Enabled only if both client ID and client secret are set
 */
const googleConfig: OAuthProviderConfig = {
  enabled: !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET),
  clientId: GOOGLE_CLIENT_ID,
  clientSecret: GOOGLE_CLIENT_SECRET,
};

/**
 * Apple OAuth provider configuration
 * Enabled only if client ID and private key are set
 * (Apple requires JWT signing with private key)
 */
const appleConfig: AppleOAuthConfig = {
  enabled: !!(APPLE_CLIENT_ID && APPLE_PRIVATE_KEY),
  clientId: APPLE_CLIENT_ID,
  teamId: APPLE_TEAM_ID,
  keyId: APPLE_KEY_ID,
  privateKey: APPLE_PRIVATE_KEY,
};

/**
 * Discord OAuth provider configuration
 * Enabled only if both client ID and client secret are set
 */
const discordConfig: OAuthProviderConfig = {
  enabled: !!(DISCORD_CLIENT_ID && DISCORD_CLIENT_SECRET),
  clientId: DISCORD_CLIENT_ID,
  clientSecret: DISCORD_CLIENT_SECRET,
};

/**
 * Map of all OAuth provider configurations
 */
const oauthProviders: Record<OAuthProviderName, OAuthProviderConfig | AppleOAuthConfig> = {
  google: googleConfig,
  apple: appleConfig,
  discord: discordConfig,
};

/**
 * The redirect URI registered with a provider. The authorization request and the token
 * request must carry an identical value, so both take it from here.
 */
export function getRedirectUri(provider: OAuthProviderName): string {
  return `${APP_URL}/api/v1/auth/oauth/${provider}/callback`;
}

// ============================================================================
// Client Configurations
// ============================================================================

/**
 * Get the OAuth client configuration for Google
 * Returns null if Google OAuth is not configured
 */
export function getGoogleConfig(): client.Configuration | null {
  if (!googleConfig.enabled || !googleConfig.clientId || !googleConfig.clientSecret) {
    return null;
  }

  return new client.Configuration(
    GOOGLE_SERVER,
    googleConfig.clientId,
    undefined,
    client.ClientSecretBasic(googleConfig.clientSecret)
  );
}

/**
 * Apple never issues a static client secret: the `client_secret` its token endpoint
 * expects is a short-lived ES256 JWT signed with the developer key, so one has to be
 * minted per token request (which is why the Apple config is async). Apple allows up to
 * 6 months; we keep it to minutes because each is used for exactly one request.
 */
const APPLE_CLIENT_SECRET_LIFETIME = "5m";

async function createAppleClientSecret(
  clientId: string,
  teamId: string,
  keyId: string,
  privateKeyPem: string
): Promise<string> {
  const privateKey = await importPKCS8(privateKeyPem, "ES256");

  return new SignJWT()
    .setProtectedHeader({ alg: "ES256", kid: keyId })
    .setIssuer(teamId)
    .setSubject(clientId)
    .setAudience(APPLE_SERVER.issuer)
    .setIssuedAt()
    .setExpirationTime(APPLE_CLIENT_SECRET_LIFETIME)
    .sign(privateKey);
}

/**
 * Get the OAuth client configuration for Apple
 * Returns null if Apple OAuth is not configured
 *
 * Apple wants its JWT client secret in the request body next to `client_id`
 * (`client_secret_post`), not in an HTTP Basic header.
 */
export async function getAppleConfig(): Promise<client.Configuration | null> {
  if (
    !appleConfig.enabled ||
    !appleConfig.clientId ||
    !appleConfig.teamId ||
    !appleConfig.keyId ||
    !appleConfig.privateKey
  ) {
    return null;
  }

  const clientSecret = await createAppleClientSecret(
    appleConfig.clientId,
    appleConfig.teamId,
    appleConfig.keyId,
    appleConfig.privateKey
  );

  return new client.Configuration(
    APPLE_SERVER,
    appleConfig.clientId,
    undefined,
    client.ClientSecretPost(clientSecret)
  );
}

/**
 * Get the configured Apple client ID (the expected `aud` claim in Apple id_tokens).
 * Returns undefined if Apple OAuth is not configured.
 */
export function getAppleClientId(): string | undefined {
  return appleConfig.clientId;
}

/**
 * Get the OAuth client configuration for Discord
 * Returns null if Discord OAuth is not configured
 */
export function getDiscordConfig(): client.Configuration | null {
  if (!discordConfig.enabled || !discordConfig.clientId || !discordConfig.clientSecret) {
    return null;
  }

  return new client.Configuration(
    DISCORD_SERVER,
    discordConfig.clientId,
    undefined,
    client.ClientSecretBasic(discordConfig.clientSecret)
  );
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Get list of enabled OAuth providers
 * Used by /v1/auth/providers endpoint to tell UI which buttons to show
 *
 * @returns Array of enabled provider names
 */
export function getEnabledProviders(): OAuthProviderName[] {
  return Object.entries(oauthProviders)
    .filter(([, config]) => config.enabled)
    .map(([name]) => name as OAuthProviderName);
}

/**
 * Check if a specific provider is enabled
 *
 * @param provider - The provider name to check
 * @returns Whether the provider is enabled
 */
export function isProviderEnabled(provider: OAuthProviderName): boolean {
  return oauthProviders[provider]?.enabled ?? false;
}

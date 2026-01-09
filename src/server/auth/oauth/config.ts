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
 */

import { Google, Apple } from "arctic";

// ============================================================================
// Types
// ============================================================================

/**
 * Supported OAuth provider names
 */
export type OAuthProviderName = "google" | "apple";

/**
 * Configuration for a single OAuth provider
 */
export interface OAuthProviderConfig {
  enabled: boolean;
  clientId?: string;
  clientSecret?: string;
}

/**
 * Extended configuration for Apple OAuth
 * Apple requires additional keys for JWT signing
 */
export interface AppleOAuthConfig extends OAuthProviderConfig {
  teamId?: string;
  keyId?: string;
  privateKey?: string;
}

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
export const googleConfig: OAuthProviderConfig = {
  enabled: !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET),
  clientId: GOOGLE_CLIENT_ID,
  clientSecret: GOOGLE_CLIENT_SECRET,
};

/**
 * Apple OAuth provider configuration
 * Enabled only if client ID and private key are set
 * (Apple requires JWT signing with private key)
 */
export const appleConfig: AppleOAuthConfig = {
  enabled: !!(APPLE_CLIENT_ID && APPLE_PRIVATE_KEY),
  clientId: APPLE_CLIENT_ID,
  teamId: APPLE_TEAM_ID,
  keyId: APPLE_KEY_ID,
  privateKey: APPLE_PRIVATE_KEY,
};

/**
 * Map of all OAuth provider configurations
 */
export const oauthProviders: Record<OAuthProviderName, OAuthProviderConfig | AppleOAuthConfig> = {
  google: googleConfig,
  apple: appleConfig,
};

// ============================================================================
// Provider Instances
// ============================================================================

/**
 * Get Google OAuth provider instance
 * Returns null if Google OAuth is not configured
 */
export function getGoogleProvider(): Google | null {
  if (!googleConfig.enabled || !googleConfig.clientId || !googleConfig.clientSecret) {
    return null;
  }

  return new Google(
    googleConfig.clientId,
    googleConfig.clientSecret,
    `${APP_URL}/auth/oauth/callback`
  );
}

/**
 * Get Apple OAuth provider instance
 * Returns null if Apple OAuth is not configured
 *
 * Note: Arctic expects the private key as a Uint8Array (PKCS8 format).
 * The environment variable should contain the PEM-encoded key,
 * which we convert to bytes by extracting the base64-encoded portion.
 */
export function getAppleProvider(): Apple | null {
  if (
    !appleConfig.enabled ||
    !appleConfig.clientId ||
    !appleConfig.teamId ||
    !appleConfig.keyId ||
    !appleConfig.privateKey
  ) {
    return null;
  }

  // Convert PEM-encoded private key to Uint8Array
  // The key should be in PKCS8 format
  const privateKeyPem = appleConfig.privateKey;
  const privateKeyBase64 = privateKeyPem
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\s/g, "");
  const privateKeyBytes = Uint8Array.from(atob(privateKeyBase64), (c) => c.charCodeAt(0));

  return new Apple(
    appleConfig.clientId,
    appleConfig.teamId,
    appleConfig.keyId,
    privateKeyBytes,
    `${APP_URL}/api/v1/auth/oauth/apple/callback`
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

/**
 * Check if any OAuth provider is enabled
 *
 * @returns Whether at least one OAuth provider is enabled
 */
export function hasAnyOAuthProvider(): boolean {
  return getEnabledProviders().length > 0;
}

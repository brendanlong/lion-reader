/**
 * OAuth 2.1 Utilities
 *
 * Token generation, hashing, and PKCE validation utilities.
 */

import crypto from "crypto";

// ============================================================================
// Constants
// ============================================================================

/**
 * Access token expiry in seconds (1 hour)
 */
export const ACCESS_TOKEN_EXPIRY_SECONDS = 3600;

/**
 * Refresh token expiry in days (30 days)
 */
export const REFRESH_TOKEN_EXPIRY_DAYS = 30;

/**
 * Authorization code expiry in seconds (10 minutes)
 */
export const AUTH_CODE_EXPIRY_SECONDS = 600;

/**
 * Available OAuth scopes
 */
export const OAUTH_SCOPES = {
  MCP: "mcp",
  SAVED_WRITE: "saved:write",
} as const;

export type OAuthScope = (typeof OAUTH_SCOPES)[keyof typeof OAUTH_SCOPES];

/**
 * Scope descriptions for consent screen
 */
export const SCOPE_DESCRIPTIONS: Record<OAuthScope, string> = {
  mcp: "Read and manage your feeds and articles",
  "saved:write": "Save articles to your library",
};

// ============================================================================
// Token Generation
// ============================================================================

/**
 * Generates a secure random token.
 * Uses 32 bytes of randomness, base64url encoded.
 */
export function generateToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

/**
 * Generates a secure authorization code.
 * Uses 32 bytes of randomness, base64url encoded.
 */
export function generateAuthorizationCode(): string {
  return crypto.randomBytes(32).toString("base64url");
}

/**
 * Hashes a token using SHA-256.
 * Used for storage - we never store raw tokens.
 */
export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

// ============================================================================
// PKCE (Proof Key for Code Exchange)
// ============================================================================

/**
 * Validates PKCE code_verifier against code_challenge using S256 method.
 *
 * S256: code_challenge = BASE64URL(SHA256(code_verifier))
 *
 * @param codeVerifier - The code_verifier from the token request
 * @param codeChallenge - The code_challenge from the authorization request
 * @returns true if the verifier matches the challenge
 */
export function validatePkceS256(codeVerifier: string, codeChallenge: string): boolean {
  // RFC 7636: code_challenge = BASE64URL(SHA256(ASCII(code_verifier)))
  const hash = crypto.createHash("sha256").update(codeVerifier, "ascii").digest();
  const computedChallenge = hash.toString("base64url");
  return computedChallenge === codeChallenge;
}

/**
 * Validates code_verifier format according to RFC 7636.
 * Must be 43-128 characters, using only [A-Z] / [a-z] / [0-9] / "-" / "." / "_" / "~"
 */
export function isValidCodeVerifier(codeVerifier: string): boolean {
  if (codeVerifier.length < 43 || codeVerifier.length > 128) {
    return false;
  }
  // RFC 7636 unreserved characters
  return /^[A-Za-z0-9\-._~]+$/.test(codeVerifier);
}

/**
 * Validates code_challenge format.
 * Must be a valid base64url string of correct length for SHA256 output.
 */
export function isValidCodeChallenge(codeChallenge: string): boolean {
  // SHA256 produces 32 bytes, which is 43 characters in base64url (without padding)
  if (codeChallenge.length !== 43) {
    return false;
  }
  // Valid base64url characters (no padding required for 43 chars)
  return /^[A-Za-z0-9\-_]+$/.test(codeChallenge);
}

// ============================================================================
// Redirect URI Validation
// ============================================================================

/**
 * Validates a redirect URI against allowed URIs for a client.
 * Uses exact string matching as required by OAuth 2.1.
 */
export function validateRedirectUri(redirectUri: string, allowedUris: string[]): boolean {
  return allowedUris.includes(redirectUri);
}

/**
 * Checks if a redirect URI is valid according to OAuth 2.1 rules.
 * - Must be HTTPS (except for localhost which can be HTTP)
 * - Must be an absolute URI
 * - Must not contain fragments
 */
export function isValidRedirectUriFormat(redirectUri: string): boolean {
  try {
    const url = new URL(redirectUri);

    // Must not have fragment
    if (url.hash) {
      return false;
    }

    // Must be HTTPS, except localhost can be HTTP
    const isLocalhost = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (!isLocalhost && url.protocol !== "https:") {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

// ============================================================================
// Scope Validation
// ============================================================================

/**
 * Parses a space-separated scope string into an array.
 */
export function parseScopes(scopeString: string | undefined): OAuthScope[] {
  if (!scopeString) {
    return [];
  }
  return scopeString
    .split(" ")
    .filter(
      (s): s is OAuthScope =>
        s in OAUTH_SCOPES || Object.values(OAUTH_SCOPES).includes(s as OAuthScope)
    );
}

/**
 * Validates requested scopes against allowed scopes.
 * Returns the intersection of requested and allowed scopes.
 */
export function validateScopes(
  requestedScopes: string[],
  allowedScopes: string[] | null
): string[] {
  // If no allowed scopes defined, allow all known scopes
  const allowed = allowedScopes ?? Object.values(OAUTH_SCOPES);
  return requestedScopes.filter((s) => allowed.includes(s));
}

// ============================================================================
// Expiry Calculation
// ============================================================================

/**
 * Calculates access token expiry date.
 */
export function getAccessTokenExpiry(): Date {
  return new Date(Date.now() + ACCESS_TOKEN_EXPIRY_SECONDS * 1000);
}

/**
 * Calculates refresh token expiry date.
 */
export function getRefreshTokenExpiry(): Date {
  const expiry = new Date();
  expiry.setDate(expiry.getDate() + REFRESH_TOKEN_EXPIRY_DAYS);
  return expiry;
}

/**
 * Calculates authorization code expiry date.
 */
export function getAuthCodeExpiry(): Date {
  return new Date(Date.now() + AUTH_CODE_EXPIRY_SECONDS * 1000);
}

// ============================================================================
// Client ID Validation
// ============================================================================

/**
 * Checks if a client_id is a URL (for Client ID Metadata Documents).
 */
export function isClientIdUrl(clientId: string): boolean {
  try {
    const url = new URL(clientId);
    return url.protocol === "https:";
  } catch {
    return false;
  }
}

// ============================================================================
// Error Types
// ============================================================================

/**
 * OAuth error codes as defined in RFC 6749
 */
export const OAUTH_ERRORS = {
  INVALID_REQUEST: "invalid_request",
  UNAUTHORIZED_CLIENT: "unauthorized_client",
  ACCESS_DENIED: "access_denied",
  UNSUPPORTED_RESPONSE_TYPE: "unsupported_response_type",
  INVALID_SCOPE: "invalid_scope",
  SERVER_ERROR: "server_error",
  TEMPORARILY_UNAVAILABLE: "temporarily_unavailable",
  INVALID_CLIENT: "invalid_client",
  INVALID_GRANT: "invalid_grant",
  UNSUPPORTED_GRANT_TYPE: "unsupported_grant_type",
  // RFC 7591 Dynamic Client Registration error codes
  INVALID_REDIRECT_URI: "invalid_redirect_uri",
  INVALID_CLIENT_METADATA: "invalid_client_metadata",
  INVALID_SOFTWARE_STATEMENT: "invalid_software_statement",
  UNAPPROVED_SOFTWARE_STATEMENT: "unapproved_software_statement",
} as const;

export type OAuthError = (typeof OAUTH_ERRORS)[keyof typeof OAUTH_ERRORS];

/**
 * OAuth error response
 */
export interface OAuthErrorResponse {
  error: OAuthError;
  error_description?: string;
  error_uri?: string;
}

/**
 * Creates an OAuth error response.
 */
export function createOAuthError(error: OAuthError, description?: string): OAuthErrorResponse {
  return {
    error,
    error_description: description,
  };
}

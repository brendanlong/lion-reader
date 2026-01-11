/**
 * Auth Module
 *
 * Exports authentication utilities and session management.
 */

export {
  generateSessionToken,
  getSessionExpiry,
  validateSession,
  revokeSession,
  revokeSessionByToken,
  invalidateUserSessionCaches,
  type SessionData,
} from "./session";

// API Token exports
export {
  createApiToken,
  validateApiToken,
  API_TOKEN_SCOPES,
  type ApiTokenScope,
  type ApiTokenData,
} from "./api-token";

// OAuth exports
export {
  getEnabledProviders,

  // Google OAuth flow
  createGoogleAuthUrl,
  validateGoogleCallback,
  isGoogleOAuthEnabled,
  GOOGLE_DOCS_READONLY_SCOPE,
  // Apple OAuth flow
  createAppleAuthUrl,
  validateAppleCallback,
  isAppleOAuthEnabled,
} from "./oauth";

// Signup helper
export { createUser } from "./signup";

// OAuth callback processing
export { processOAuthCallback } from "./oauth/callback";

/**
 * Auth Module
 *
 * Exports authentication utilities and session management.
 */

export {
  generateSessionToken,
  hashToken,
  getSessionExpiry,
  validateSession,
  revokeSession,
  revokeSessionByToken,
  revokeAllUserSessions,
  invalidateUserSessionCaches,
  SESSION_DURATION_DAYS,
  type SessionData,
} from "./session";

// API Token exports
export {
  generateApiToken,
  hashApiToken,
  createApiToken,
  validateApiToken,
  hasScope,
  revokeApiToken,
  revokeAllUserApiTokens,
  API_TOKEN_SCOPES,
  type ApiTokenScope,
  type ApiTokenData,
} from "./api-token";

// OAuth exports
export {
  type OAuthProviderName,
  type OAuthProviderConfig,
  type AppleOAuthConfig,
  googleConfig,
  appleConfig,
  oauthProviders,
  getGoogleProvider,
  getAppleProvider,
  getEnabledProviders,
  isProviderEnabled,
  hasAnyOAuthProvider,
  // Google OAuth flow
  type GoogleUserInfo,
  type GoogleAuthUrlResult,
  type GoogleAuthResult,
  type OAuthMode,
  createGoogleAuthUrl,
  validateGoogleCallback,
  isGoogleOAuthEnabled,
  GOOGLE_DOCS_READONLY_SCOPE,
  // Apple OAuth flow
  type AppleUserInfo,
  type AppleFirstAuthUserData,
  type AppleAuthUrlResult,
  type AppleAuthResult,
  createAppleAuthUrl,
  validateAppleCallback,
  isAppleOAuthEnabled,
  isApplePrivateRelayEmail,
} from "./oauth";

// Signup helper
export { createUser, type CreateUserParams, type CreateUserResult } from "./signup";

// OAuth callback processing
export {
  processOAuthCallback,
  type OAuthProvider,
  type ProcessOAuthCallbackParams,
  type ProcessOAuthCallbackResult,
} from "./oauth/callback";

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
  SESSION_DURATION_DAYS,
  type SessionData,
} from "./session";

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
} from "./oauth";

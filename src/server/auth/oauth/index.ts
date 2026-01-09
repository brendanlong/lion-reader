/**
 * OAuth Module
 *
 * Exports OAuth configuration and provider utilities.
 */

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
} from "./config";

// Google OAuth flow exports
export {
  type GoogleUserInfo,
  type GoogleAuthUrlResult,
  type GoogleAuthResult,
  type OAuthMode,
  createGoogleAuthUrl,
  validateGoogleCallback,
  isGoogleOAuthEnabled,
  GOOGLE_DOCS_READONLY_SCOPE,
} from "./google";

// Apple OAuth flow exports
export {
  type AppleUserInfo,
  type AppleFirstAuthUserData,
  type AppleAuthUrlResult,
  type AppleAuthResult,
  createAppleAuthUrl,
  validateAppleCallback,
  isAppleOAuthEnabled,
  isApplePrivateRelayEmail,
} from "./apple";

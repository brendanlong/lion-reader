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
  createGoogleAuthUrl,
  validateGoogleCallback,
  isGoogleOAuthEnabled,
} from "./google";

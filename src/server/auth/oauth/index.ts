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

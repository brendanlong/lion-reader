/**
 * OAuth Module
 *
 * Exports OAuth configuration and provider utilities.
 */

export { getEnabledProviders } from "./config";

// Google OAuth flow exports
export {
  createGoogleAuthUrl,
  validateGoogleCallback,
  isGoogleOAuthEnabled,
  GOOGLE_DOCS_READONLY_SCOPE,
} from "./google";

// Apple OAuth flow exports
export { createAppleAuthUrl, validateAppleCallback, isAppleOAuthEnabled } from "./apple";

// Discord OAuth flow exports
export { createDiscordAuthUrl, validateDiscordCallback, isDiscordOAuthEnabled } from "./discord";

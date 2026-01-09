/**
 * Google OAuth Token Management
 *
 * Handles token refresh and validation for accessing Google APIs with user credentials.
 * Used for Phase 2 of Google Docs integration to access private documents.
 */

import { eq, and } from "drizzle-orm";
import { db } from "@/server/db";
import { oauthAccounts } from "@/server/db/schema";
import { getGoogleProvider } from "@/server/auth/oauth/config";
import { logger } from "@/lib/logger";

/**
 * Minimum time before expiry to trigger token refresh (5 minutes buffer)
 */
const TOKEN_REFRESH_BUFFER_SECONDS = 300;

/**
 * Gets a valid Google OAuth access token for a user.
 * Automatically refreshes the token if it's expired or about to expire.
 *
 * @param userId - The user's ID
 * @returns Valid access token
 * @throws Error if no Google OAuth account exists or refresh fails
 */
export async function getValidGoogleToken(userId: string): Promise<string> {
  const oauth = await db.query.oauthAccounts.findFirst({
    where: and(eq(oauthAccounts.userId, userId), eq(oauthAccounts.provider, "google")),
  });

  if (!oauth) {
    throw new Error("No Google OAuth account linked");
  }

  if (!oauth.accessToken) {
    throw new Error("No access token stored for Google OAuth account");
  }

  // Check if token is expired or about to expire
  const expiresIn = oauth.expiresAt
    ? (oauth.expiresAt.getTime() - Date.now()) / 1000
    : Infinity;

  if (expiresIn > TOKEN_REFRESH_BUFFER_SECONDS) {
    // Token is still valid
    logger.debug("Using existing Google access token", {
      userId,
      expiresIn: Math.round(expiresIn),
    });
    return oauth.accessToken;
  }

  // Token is expired or about to expire, refresh it
  logger.debug("Google access token expired or expiring soon, refreshing", {
    userId,
    expiresIn: Math.round(expiresIn),
  });

  if (!oauth.refreshToken) {
    throw new Error("No refresh token available - user must re-authenticate");
  }

  const newToken = await refreshGoogleToken(oauth.id, oauth.refreshToken);
  return newToken;
}

/**
 * Refreshes a Google OAuth access token using a refresh token.
 *
 * @param oauthAccountId - The OAuth account ID
 * @param refreshToken - The refresh token
 * @returns New access token
 * @throws Error if refresh fails
 */
async function refreshGoogleToken(oauthAccountId: string, refreshToken: string): Promise<string> {
  const google = getGoogleProvider();

  if (!google) {
    throw new Error("Google OAuth is not configured");
  }

  try {
    // Use arctic's refreshAccessToken method
    const tokens = await google.refreshAccessToken(refreshToken);

    // Update stored tokens in database
    await db
      .update(oauthAccounts)
      .set({
        accessToken: tokens.accessToken(),
        expiresAt: tokens.accessTokenExpiresAt(),
        // Some providers rotate refresh tokens - update if provided
        ...(tokens.hasRefreshToken() ? { refreshToken: tokens.refreshToken() } : {}),
      })
      .where(eq(oauthAccounts.id, oauthAccountId));

    logger.info("Successfully refreshed Google access token", {
      oauthAccountId,
      expiresAt: tokens.accessTokenExpiresAt(),
    });

    return tokens.accessToken();
  } catch (error) {
    logger.error("Failed to refresh Google access token", {
      oauthAccountId,
      error: error instanceof Error ? error.message : String(error),
    });
    throw new Error("Failed to refresh Google access token - user must re-authenticate");
  }
}

/**
 * Checks if a user has a specific OAuth scope granted.
 *
 * @param userId - The user's ID
 * @param scope - The OAuth scope to check
 * @returns Whether the user has granted the scope
 */
export async function hasGoogleScope(userId: string, scope: string): Promise<boolean> {
  const oauth = await db.query.oauthAccounts.findFirst({
    where: and(eq(oauthAccounts.userId, userId), eq(oauthAccounts.provider, "google")),
  });

  if (!oauth || !oauth.scopes) {
    return false;
  }

  return oauth.scopes.includes(scope);
}

/**
 * Gets the OAuth account for a user and provider.
 *
 * @param userId - The user's ID
 * @param provider - The OAuth provider ('google', 'apple', etc.)
 * @returns OAuth account or null if not found
 */
export async function getOAuthAccount(userId: string, provider: string) {
  return db.query.oauthAccounts.findFirst({
    where: and(eq(oauthAccounts.userId, userId), eq(oauthAccounts.provider, provider)),
  });
}

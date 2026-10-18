/**
 * Google OAuth Token Management
 *
 * Handles token refresh and validation for accessing Google APIs with user credentials.
 * Used for Phase 2 of Google Docs integration to access private documents.
 */

import { eq, and } from "drizzle-orm";
import * as client from "openid-client";
import { db } from "@/server/db";
import { oauthAccounts } from "@/server/db/schema";
import { getGoogleConfig } from "@/server/auth/oauth/config";
import { accessTokenExpiresAt } from "@/server/auth/oauth/token-exchange";
import { logger } from "@/lib/logger";
import { GOOGLE_DOCS_SCOPE } from "./docs";
import { GOOGLE_DRIVE_SCOPE } from "./drive";

type GoogleOAuthAccount = typeof oauthAccounts.$inferSelect;

/**
 * The scopes saving a private Google Doc needs: documents.readonly for native
 * docs (Docs API) and drive.readonly for uploaded .docx files (Drive API).
 * Every consent request and grant check uses this one list.
 */
export const GOOGLE_DOCS_SCOPES: readonly string[] = [GOOGLE_DOCS_SCOPE, GOOGLE_DRIVE_SCOPE];

type GoogleDocsGrant =
  | { status: "unlinked" }
  | { status: "missing-scopes" }
  | { status: "granted"; account: GoogleOAuthAccount };

/** Whether a user's linked Google account has granted every `GOOGLE_DOCS_SCOPES` scope. */
export async function getGoogleDocsGrant(userId: string): Promise<GoogleDocsGrant> {
  const account = await db.query.oauthAccounts.findFirst({
    where: and(eq(oauthAccounts.userId, userId), eq(oauthAccounts.provider, "google")),
  });
  if (!account) return { status: "unlinked" };
  const scopes = account.scopes ?? [];
  if (!GOOGLE_DOCS_SCOPES.every((scope) => scopes.includes(scope))) {
    return { status: "missing-scopes" };
  }
  return { status: "granted", account };
}

/**
 * Minimum time before expiry to trigger token refresh (5 minutes buffer)
 */
const TOKEN_REFRESH_BUFFER_SECONDS = 300;

/**
 * Gets a valid access token for a linked Google account, refreshing it if it's
 * expired or about to expire.
 *
 * @throws Error if the account has no token or refresh fails
 */
export async function getValidGoogleToken(oauth: GoogleOAuthAccount): Promise<string> {
  const userId = oauth.userId;

  if (!oauth.accessToken) {
    throw new Error("No access token stored for Google OAuth account");
  }

  // Check if token is expired or about to expire
  const expiresIn = oauth.expiresAt ? (oauth.expiresAt.getTime() - Date.now()) / 1000 : Infinity;

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
    throw new Error("GOOGLE_NEEDS_REAUTH");
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
  const config = getGoogleConfig();

  if (!config) {
    throw new Error("Google OAuth is not configured");
  }

  try {
    const tokens = await client.refreshTokenGrant(config, refreshToken);
    const expiresAt = accessTokenExpiresAt(tokens);

    // Update stored tokens in database
    await db
      .update(oauthAccounts)
      .set({
        accessToken: tokens.access_token,
        // `?? null` matters: Drizzle drops `undefined` from `set()`, which would leave
        // the old (already past) expiry next to a fresh token and re-refresh forever.
        expiresAt: expiresAt ?? null,
        // Some providers rotate refresh tokens - update if provided
        ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
      })
      .where(eq(oauthAccounts.id, oauthAccountId));

    logger.info("Successfully refreshed Google access token", {
      oauthAccountId,
      expiresAt,
    });

    return tokens.access_token;
  } catch (error) {
    logger.error("Failed to refresh Google access token", {
      oauthAccountId,
      error: error instanceof Error ? error.message : String(error),
    });
    throw new Error("GOOGLE_NEEDS_REAUTH");
  }
}

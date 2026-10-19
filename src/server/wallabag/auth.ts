/**
 * Wallabag API Authentication
 *
 * Handles OAuth 2.0 password grant flow for Wallabag-compatible clients.
 *
 * Wallabag clients authenticate by POSTing to /oauth/v2/token with:
 *   grant_type=password, client_id, client_secret, username, password
 *
 * We reuse the existing OAuth 2.1 token infrastructure, but support the
 * password grant type which Wallabag requires, minting every credential under
 * `WALLABAG_CLIENT_ID`.
 */

import { db } from "@/server/db";
import { verifyEmailPassword } from "@/server/auth/password";
import { extractBearerToken } from "@/server/auth/bearer";
import { authenticateCredential } from "@/server/auth/credential";
import { revokeUserClientTokens } from "@/server/oauth/grants";
import { createTokens, rotateRefreshToken } from "@/server/oauth/service";
import { OAUTH_SCOPES } from "@/server/oauth/utils";
import { logger } from "@/lib/logger";
import { errorResponse } from "./parse";
import { WALLABAG_CLIENT_ID } from "./client";

/**
 * Wallabag OAuth token response
 */
export interface WallabagTokenResponse {
  access_token: string;
  expires_in: number;
  token_type: "bearer";
  scope: null;
  refresh_token: string;
}

/**
 * Handles the OAuth password grant for Wallabag clients.
 *
 * Validates user credentials and returns access/refresh tokens.
 */
export async function passwordGrant(
  username: string,
  password: string
): Promise<WallabagTokenResponse | null> {
  const login = await verifyEmailPassword(db, username, password);
  if (!login.valid) {
    const { user } = login;
    logger.warn("Wallabag password grant failed", {
      component: "wallabag",
      grantType: "password",
      userId: user?.id,
      reason: !user ? "user_not_found" : !user.passwordHash ? "no_password" : "invalid_password",
    });
    return null;
  }
  // The Wallabag surface covers the full reader API (list/read/mutate/delete
  // entries + tags), so it is granted reader:full-access rather than the narrow
  // saved:write scope — and requireAuth enforces that scope on every endpoint.
  const tokens = await createTokens({
    clientId: WALLABAG_CLIENT_ID,
    userId: login.user.id,
    scopes: [OAUTH_SCOPES.READER_FULL_ACCESS],
  });

  logger.info("Wallabag password grant succeeded", {
    component: "wallabag",
    grantType: "password",
    userId: login.user.id,
  });

  return {
    access_token: tokens.accessToken,
    expires_in: tokens.expiresIn,
    token_type: "bearer",
    scope: null,
    refresh_token: tokens.refreshToken,
  };
}

/**
 * Signs out every Wallabag app for a user (Settings → Wallabag).
 */
export async function revokeWallabagTokens(userId: string): Promise<void> {
  await revokeUserClientTokens(userId, WALLABAG_CLIENT_ID);
}

/**
 * Handles the refresh_token grant for Wallabag clients.
 */
export async function refreshTokenGrant(
  refreshToken: string
): Promise<WallabagTokenResponse | null> {
  const tokens = await rotateRefreshToken(refreshToken, WALLABAG_CLIENT_ID);
  if (!tokens) {
    // Rotation returned null: the presented refresh token was unknown, expired,
    // or already-rotated (reuse). This is the key "flaky sync" signal — a client
    // that suddenly can't refresh. rotateRefreshToken logs the reuse case with
    // the user/family it revoked; here we just record the outcome.
    logger.warn("Wallabag refresh grant failed", {
      component: "wallabag",
      grantType: "refresh_token",
      reason: "invalid_or_revoked",
    });
    return null;
  }

  logger.info("Wallabag refresh grant succeeded", {
    component: "wallabag",
    grantType: "refresh_token",
  });

  return {
    access_token: tokens.accessToken,
    expires_in: tokens.expiresIn,
    token_type: "bearer",
    scope: null,
    refresh_token: tokens.refreshToken,
  };
}

/**
 * Validates a Wallabag API request and returns the user data.
 *
 * Only tokens from the Wallabag password grant are accepted, never another
 * OAuth client's, whatever their scopes. Every Wallabag endpoint exposes the
 * full reader surface (list/read/mutate/delete entries + tags), so all of them
 * also require the `reader:full-access` scope.
 *
 * Returns a `Response` (401 unauthenticated / 403 insufficient scope or
 * unconfirmed signup) that callers must forward, e.g.
 * `const auth = await requireAuth(request); if (auth instanceof Response) return auth;`.
 * (We return rather than throw because Next.js App Router route handlers don't
 * convert a thrown `Response` into the HTTP response — it surfaces as a 500.)
 */
export async function requireAuth(
  request: Request
): Promise<{ userId: string; email: string } | Response> {
  const token = extractBearerToken(request.headers.get("authorization"));
  const auth = await authenticateCredential(token, {
    accept: ["wallabag_token"],
    requiredScopes: [OAUTH_SCOPES.READER_FULL_ACCESS],
    requireConfirmed: true,
  });
  if (auth.ok) return { userId: auth.credential.user.id, email: auth.credential.user.email };

  switch (auth.reason) {
    case "unauthenticated":
      // Distinguish a client that sent no Bearer at all (misconfigured) from one
      // that sent a token we rejected (expired — normal churn as clients lazily
      // refresh — revoked, e.g. by reuse detection, or another client's).
      // Logged at info because an expired-token 401 is expected traffic.
      logger.info("Wallabag request unauthenticated", {
        component: "wallabag",
        reason: token ? "invalid_token" : "missing_bearer",
      });
      return errorResponse("invalid_grant", "Unauthorized", 401);
    case "insufficient_scope":
      logger.warn("Wallabag request rejected: insufficient scope", {
        component: "wallabag",
        userId: auth.credential.user.id,
        scopes: auth.credential.scopes,
      });
      return errorResponse(
        "insufficient_scope",
        `This endpoint requires the ${OAUTH_SCOPES.READER_FULL_ACCESS} scope`,
        403
      );
    case "unconfirmed":
      logger.warn("Wallabag request rejected: signup not confirmed", {
        component: "wallabag",
        userId: auth.credential.user.id,
      });
      return errorResponse("access_denied", "Signup confirmation required", 403);
  }
}

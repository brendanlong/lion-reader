/**
 * Wallabag API Authentication
 *
 * Handles OAuth 2.0 password grant flow for Wallabag-compatible clients.
 *
 * Wallabag clients authenticate by POSTing to /oauth/v2/token with:
 *   grant_type=password, client_id, client_secret, username, password
 *
 * We reuse the existing OAuth 2.1 token infrastructure, but support the
 * password grant type which Wallabag requires. Client registration uses
 * the dynamic registration endpoint.
 *
 * For simplicity, we also support a "wallabag" client_id that doesn't
 * require pre-registration — any valid user credentials work.
 */

import * as argon2 from "argon2";
import { eq } from "drizzle-orm";
import { db } from "@/server/db";
import { users } from "@/server/db/schema";
import { validateAccessToken, createTokens, rotateRefreshToken } from "@/server/oauth/service";

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
  password: string,
  clientId: string
): Promise<WallabagTokenResponse | null> {
  // Find user by email
  const user = await db.select().from(users).where(eq(users.email, username)).limit(1);

  if (user.length === 0) {
    return null;
  }

  const foundUser = user[0];

  // Check if user has a password
  if (!foundUser.passwordHash) {
    return null;
  }

  // Verify password
  const isValid = await argon2.verify(foundUser.passwordHash, password);
  if (!isValid) {
    return null;
  }

  // Create OAuth tokens using existing infrastructure
  const tokens = await createTokens({
    clientId,
    userId: foundUser.id,
    scopes: ["saved:write"],
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
 * Handles the refresh_token grant for Wallabag clients.
 */
export async function refreshTokenGrant(
  refreshToken: string,
  clientId: string
): Promise<WallabagTokenResponse | null> {
  const tokens = await rotateRefreshToken(refreshToken, clientId);
  if (!tokens) {
    return null;
  }

  return {
    access_token: tokens.accessToken,
    expires_in: tokens.expiresIn,
    token_type: "bearer",
    scope: null,
    refresh_token: tokens.refreshToken,
  };
}

/**
 * Validates a Wallabag API request using Bearer token.
 * Returns user data if authenticated.
 */
export async function authenticateRequest(
  request: Request
): Promise<{ userId: string; email: string } | null> {
  const authHeader = request.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return null;
  }

  const token = authHeader.slice(7);
  const tokenData = await validateAccessToken(token);
  if (!tokenData) {
    return null;
  }

  return {
    userId: tokenData.userId,
    email: tokenData.user.email,
  };
}

/**
 * Validates a Wallabag API request and returns the user data.
 * Throws a 401 response if not authenticated.
 */
export async function requireAuth(request: Request): Promise<{ userId: string; email: string }> {
  const auth = await authenticateRequest(request);
  if (!auth) {
    throw new Response(
      JSON.stringify({ error: "invalid_grant", error_description: "Unauthorized" }),
      {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
  return auth;
}

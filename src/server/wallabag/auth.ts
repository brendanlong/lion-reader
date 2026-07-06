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
import { OAUTH_SCOPES } from "@/server/oauth/utils";

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

  // Create OAuth tokens using existing infrastructure. The Wallabag surface
  // covers the full reader API (list/read/mutate/delete entries + tags), so it
  // is granted reader:full-access rather than the narrow saved:write scope —
  // and requireAuth enforces that scope on every endpoint (see below).
  const tokens = await createTokens({
    clientId,
    userId: foundUser.id,
    scopes: [OAUTH_SCOPES.READER_FULL_ACCESS],
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
async function authenticateRequest(
  request: Request
): Promise<{ userId: string; email: string; scopes: string[] } | null> {
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
    scopes: tokenData.scopes,
  };
}

/**
 * Validates a Wallabag API request and returns the user data.
 *
 * Every Wallabag endpoint exposes the full reader surface (list/read/mutate/
 * delete entries + tags), so all of them require the `reader:full-access`
 * scope. A token that authenticates but lacks the scope (e.g. a `saved:write`
 * save-only credential) is rejected with 403 — this is what prevents a narrow
 * scope from being replayed for full library access.
 *
 * Returns a `Response` (401 unauthenticated / 403 insufficient scope) that
 * callers must forward, e.g.
 * `const auth = await requireAuth(request); if (auth instanceof Response) return auth;`.
 * (We return rather than throw because Next.js App Router route handlers don't
 * convert a thrown `Response` into the HTTP response — it surfaces as a 500.)
 */
export async function requireAuth(
  request: Request
): Promise<{ userId: string; email: string } | Response> {
  const auth = await authenticateRequest(request);
  if (!auth) {
    return new Response(
      JSON.stringify({ error: "invalid_grant", error_description: "Unauthorized" }),
      {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
  if (!auth.scopes.includes(OAUTH_SCOPES.READER_FULL_ACCESS)) {
    return new Response(
      JSON.stringify({
        error: "insufficient_scope",
        error_description: `This endpoint requires the ${OAUTH_SCOPES.READER_FULL_ACCESS} scope`,
      }),
      {
        status: 403,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
  return { userId: auth.userId, email: auth.email };
}

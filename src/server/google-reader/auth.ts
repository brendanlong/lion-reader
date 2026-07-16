/**
 * Google Reader API Authentication
 *
 * Handles the GoogleLogin auth flow:
 * 1. Client POSTs to ClientLogin with email/password
 * 2. Server returns an auth token (reuses our session token system)
 * 3. Client sends `Authorization: GoogleLogin auth={token}` on subsequent requests
 *
 * We reuse the existing session infrastructure — a GoogleLogin auth token
 * is just a regular session token with a different transport mechanism.
 */

import { eq } from "drizzle-orm";
import { db } from "@/server/db";
import { users } from "@/server/db/schema";
import { verifyPassword } from "@/server/auth/password";
import { createSession, validateSession, type SessionData } from "@/server/auth/session";
import { extractBearerToken } from "@/server/auth/bearer";
import { isSignupConfirmed } from "@/server/auth/confirmation";
import { OAUTH_SCOPES } from "@/server/oauth/utils";

/**
 * Authenticates a user with email/password and returns session credentials
 * in Google Reader ClientLogin format.
 *
 * Returns the response body string:
 * ```
 * SID=unused
 * LSID=unused
 * Auth={sessionToken}
 * ```
 */
export async function clientLogin(
  email: string,
  password: string,
  userAgent?: string,
  ipAddress?: string
): Promise<{ auth: string } | null> {
  // Find user by email
  const user = await db.select().from(users).where(eq(users.email, email)).limit(1);

  if (user.length === 0) {
    // Equalize timing: run argon2 against a decoy so a non-existent account
    // isn't measurably faster than a real password check (no enumeration
    // oracle, #1267).
    await verifyPassword(null, password);
    return null;
  }

  const foundUser = user[0];

  // Check if user has a password
  if (!foundUser.passwordHash) {
    // Equalize timing for OAuth-only (passwordless) accounts too (#1267).
    await verifyPassword(null, password);
    return null;
  }

  // Verify password
  const isValid = await verifyPassword(foundUser.passwordHash, password);
  if (!isValid) {
    return null;
  }

  // Create a session (reuses existing session infrastructure), restricted to
  // the reader surface. Unlike a browser login, a Google Reader token must not
  // be replayable as a full-access session cookie (account settings, password,
  // deletion) — the scope confines it to what the Google Reader API exposes.
  const { token } = await createSession(db, {
    userId: foundUser.id,
    userAgent,
    ipAddress,
    scopes: [OAUTH_SCOPES.READER_FULL_ACCESS],
  });

  return { auth: token };
}

/**
 * Extracts the auth token from a Google Reader Authorization header.
 *
 * Supports two formats:
 * - `GoogleLogin auth={token}` (standard Google Reader format)
 * - `Bearer {token}` (some clients use this)
 */
export function extractAuthToken(request: Request): string | null {
  const authHeader = request.headers.get("authorization");
  if (!authHeader) return null;

  // GoogleLogin auth={token}
  const googleLoginMatch = authHeader.match(/^GoogleLogin\s+auth=(.+)$/i);
  if (googleLoginMatch) {
    return googleLoginMatch[1];
  }

  // Bearer {token}
  const bearerToken = extractBearerToken(authHeader);
  if (bearerToken) {
    return bearerToken;
  }

  return null;
}

/**
 * Validates a Google Reader request and returns the authenticated session.
 * Returns null if the request carries no valid session token at all. A session
 * that authenticates but is scoped to something other than the reader surface,
 * or belongs to an unconfirmed user, is a valid session and returned here — the
 * scope/confirmation gates live in {@link requireAuth} so it can distinguish
 * those cases (403) from an unauthenticated request (401).
 */
async function authenticateRequest(request: Request): Promise<SessionData | null> {
  const token = extractAuthToken(request);
  if (!token) return null;

  // Google Reader tokens are scoped sessions, so opt into scoped validation.
  return validateSession(token, { allowScoped: true });
}

/**
 * Validates a Google Reader request and returns the session.
 *
 * Returns a `Response` that callers must forward, e.g.
 * `const session = await requireAuth(request); if (session instanceof Response) return session;`:
 * - **401** if the request is unauthenticated (missing/invalid token).
 * - **403** if the session authenticates but is scoped to something other than
 *   `reader:full-access` (a browser session with NULL scopes is full access and
 *   allowed), or the user hasn't completed signup confirmation — the same gates
 *   the tRPC and MCP surfaces enforce.
 *
 * (We return rather than throw because Next.js App Router route handlers don't
 * convert a thrown `Response` into the HTTP response — it surfaces as a 500.)
 */
export async function requireAuth(request: Request): Promise<SessionData | Response> {
  const session = await authenticateRequest(request);
  if (!session) {
    return new Response("Unauthorized", { status: 401 });
  }

  // A browser session (NULL scopes) is full access; a scoped session must carry
  // reader:full-access. Any other restricted scope is rejected with 403.
  const scopes = session.session.scopes;
  if (scopes !== null && !scopes.includes(OAUTH_SCOPES.READER_FULL_ACCESS)) {
    return new Response("Insufficient scope", { status: 403 });
  }

  if (!isSignupConfirmed(session.user)) {
    return new Response("Signup confirmation required", { status: 403 });
  }

  return session;
}

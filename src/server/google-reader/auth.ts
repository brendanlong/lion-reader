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

import * as argon2 from "argon2";
import { eq } from "drizzle-orm";
import { db } from "@/server/db";
import { users } from "@/server/db/schema";
import { createSession, validateSession, type SessionData } from "@/server/auth/session";
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
  const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i);
  if (bearerMatch) {
    return bearerMatch[1];
  }

  return null;
}

/**
 * Validates a Google Reader request and returns the authenticated session.
 * Returns null if not authenticated.
 */
async function authenticateRequest(request: Request): Promise<SessionData | null> {
  const token = extractAuthToken(request);
  if (!token) return null;

  // Google Reader tokens are scoped sessions, so opt into scoped validation.
  // Accept a session that is either full access (a browser session, NULL scopes)
  // or explicitly granted reader:full-access; reject any other restricted scope.
  const session = await validateSession(token, { allowScoped: true });
  if (!session) return null;

  const scopes = session.session.scopes;
  if (scopes !== null && !scopes.includes(OAUTH_SCOPES.READER_FULL_ACCESS)) {
    return null;
  }

  return session;
}

/**
 * Validates a Google Reader request and returns the session.
 *
 * Returns a 401 `Response` if not authenticated — callers must forward it, e.g.
 * `const session = await requireAuth(request); if (session instanceof Response) return session;`.
 * (We return rather than throw because Next.js App Router route handlers don't
 * convert a thrown `Response` into the HTTP response — it surfaces as a 500.)
 */
export async function requireAuth(request: Request): Promise<SessionData | Response> {
  const session = await authenticateRequest(request);
  if (!session) {
    return new Response("Unauthorized", { status: 401 });
  }
  return session;
}

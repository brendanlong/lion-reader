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

import { db } from "@/server/db";
import { verifyEmailPassword } from "@/server/auth/password";
import { createSession, type SessionData } from "@/server/auth/session";
import { extractBearerToken } from "@/server/auth/bearer";
import { authenticateCredential } from "@/server/auth/credential";
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
  const login = await verifyEmailPassword(db, email, password);
  if (!login.valid) {
    return null;
  }

  // Create a session (reuses existing session infrastructure), restricted to
  // the reader surface. Unlike a browser login, a Google Reader token must not
  // be replayable as a full-access session cookie (account settings, password,
  // deletion) — the scope confines it to what the Google Reader API exposes.
  const { token } = await createSession(db, {
    userId: login.user.id,
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
 * Validates a Google Reader request and returns the session: a `ClientLogin`
 * session scoped to `reader:full-access`, or a full-access browser session.
 *
 * Returns a `Response` that callers must forward, e.g.
 * `const session = await requireAuth(request); if (session instanceof Response) return session;`:
 * - **401** if the request is unauthenticated (missing/invalid token).
 * - **403** if the session is scoped to something other than
 *   `reader:full-access`, or the user hasn't completed signup confirmation.
 *
 * (We return rather than throw because Next.js App Router route handlers don't
 * convert a thrown `Response` into the HTTP response — it surfaces as a 500.)
 */
export async function requireAuth(request: Request): Promise<SessionData | Response> {
  const auth = await authenticateCredential(extractAuthToken(request), {
    accept: ["session", "scoped_session"],
    requiredScopes: [OAUTH_SCOPES.READER_FULL_ACCESS],
    requireConfirmed: true,
  });
  if (auth.ok) return auth.credential.session;
  switch (auth.reason) {
    case "unauthenticated":
      return new Response("Unauthorized", { status: 401 });
    case "insufficient_scope":
      return new Response("Insufficient scope", { status: 403 });
    case "unconfirmed":
      return new Response("Signup confirmation required", { status: 403 });
  }
}

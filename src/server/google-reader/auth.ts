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

  // Create a session (reuses existing session infrastructure)
  const { token } = await createSession(db, {
    userId: foundUser.id,
    userAgent,
    ipAddress,
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
export async function authenticateRequest(request: Request): Promise<SessionData | null> {
  const token = extractAuthToken(request);
  if (!token) return null;

  return validateSession(token);
}

/**
 * Validates a Google Reader request and returns the session.
 * Throws a 401 response if not authenticated.
 */
export async function requireAuth(request: Request): Promise<SessionData> {
  const session = await authenticateRequest(request);
  if (!session) {
    throw new Response("Unauthorized", { status: 401 });
  }
  return session;
}

/**
 * tRPC Context
 *
 * This module creates the context that is available to all tRPC procedures.
 * The context includes database access and session information.
 */

import { type FetchCreateContextFnOptions } from "@trpc/server/adapters/fetch";
import { eq, and, isNull, gt } from "drizzle-orm";
import { db, type Database } from "@/server/db";
import { sessions, users, type User, type Session } from "@/server/db/schema";
import crypto from "crypto";

/**
 * Session data available in context
 */
export interface SessionData {
  session: Session;
  user: User;
}

/**
 * Context available to all tRPC procedures
 */
export interface Context {
  db: Database;
  session: SessionData | null;
  /**
   * Request headers - useful for getting client info
   */
  headers: Headers;
}

/**
 * Extracts session token from request headers.
 * Supports both cookie-based and Authorization header authentication.
 */
function getSessionToken(headers: Headers): string | null {
  // Check Authorization header first (for API clients)
  const authHeader = headers.get("authorization");
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice(7);
  }

  // Check cookie (for browser clients)
  const cookieHeader = headers.get("cookie");
  if (cookieHeader) {
    const cookies = Object.fromEntries(
      cookieHeader.split("; ").map((c) => {
        const [key, ...value] = c.split("=");
        return [key, value.join("=")];
      })
    );
    if (cookies.session) {
      return cookies.session;
    }
  }

  return null;
}

/**
 * Validates a session token and returns the session with user data.
 * Returns null if the token is invalid, expired, or revoked.
 */
async function validateSession(token: string): Promise<SessionData | null> {
  // Hash the token to compare with stored hash
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

  // Find session by token hash, ensuring it's not revoked and not expired
  const result = await db
    .select({
      session: sessions,
      user: users,
    })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(
      and(
        eq(sessions.tokenHash, tokenHash),
        isNull(sessions.revokedAt),
        gt(sessions.expiresAt, new Date())
      )
    )
    .limit(1);

  if (result.length === 0) {
    return null;
  }

  const { session, user } = result[0];

  // Update last_active_at asynchronously (fire and forget)
  // This doesn't block the request
  void db
    .update(sessions)
    .set({ lastActiveAt: new Date() })
    .where(eq(sessions.id, session.id))
    .catch((err) => {
      console.error("Failed to update session last_active_at:", err);
    });

  return { session, user };
}

/**
 * Creates the tRPC context for each request.
 * This is called for every request and provides access to the database
 * and current user session.
 */
export async function createContext(opts: FetchCreateContextFnOptions): Promise<Context> {
  const { req } = opts;

  // Extract and validate session token
  const token = getSessionToken(req.headers);
  const session = token ? await validateSession(token) : null;

  return {
    db,
    session,
    headers: req.headers,
  };
}

export type { Context as TRPCContext };

/**
 * tRPC Context
 *
 * This module creates the context that is available to all tRPC procedures.
 * The context includes database access and session information.
 */

import { type FetchCreateContextFnOptions } from "@trpc/server/adapters/fetch";
import { db, type Database } from "@/server/db";
import { validateSession, type SessionData } from "@/server/auth";

// Re-export SessionData for use in other modules
export type { SessionData };

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
  /**
   * The raw session token (if present).
   * Useful for logout to revoke the current session.
   */
  sessionToken: string | null;
  /**
   * Rate limit response headers (set by rate limiting middleware).
   * Applied to the response after processing.
   */
  rateLimitHeaders?: Record<string, string>;
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
 * Creates the tRPC context for each request.
 * This is called for every request and provides access to the database
 * and current user session.
 *
 * Session validation uses Redis cache for fast lookups (5 min TTL),
 * falling back to database on cache miss.
 */
export async function createContext(opts: FetchCreateContextFnOptions): Promise<Context> {
  const { req } = opts;

  // Extract and validate session token
  const token = getSessionToken(req.headers);
  const session = token ? await validateSession(token) : null;

  return {
    db,
    session,
    sessionToken: token,
    headers: req.headers,
  };
}

export type { Context as TRPCContext };

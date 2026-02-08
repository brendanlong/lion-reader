/**
 * tRPC Context
 *
 * This module creates the context that is available to all tRPC procedures.
 * The context includes database access and session/API token information.
 */

import { type FetchCreateContextFnOptions } from "@trpc/server/adapters/fetch";
import { db, type Database } from "@/server/db";
import { validateSession, type SessionData } from "@/server/auth/session";
import { validateApiToken, type ApiTokenData, type ApiTokenScope } from "@/server/auth/api-token";

// Re-export types for use in other modules
/**
 * Authentication type - either a user session or an API token
 */
export type AuthType = "session" | "api_token";

/**
 * Context available to all tRPC procedures
 */
export interface Context {
  db: Database;
  /**
   * Session data (if authenticated via session token).
   * For API tokens, this contains user data but session is synthetic.
   */
  session: SessionData | null;
  /**
   * API token data (if authenticated via API token).
   */
  apiToken: ApiTokenData | null;
  /**
   * The type of authentication used (session or api_token).
   */
  authType: AuthType | null;
  /**
   * Scopes available for this request.
   * Empty array for session auth (full access), populated for API tokens.
   */
  scopes: ApiTokenScope[];
  /**
   * Request headers - useful for getting client info
   */
  headers: Headers;
  /**
   * The raw token (if present).
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
 * Extracts bearer token from request headers.
 * Supports both cookie-based and Authorization header authentication.
 */
function getToken(headers: Headers): string | null {
  // Check Authorization header first (for API clients and extensions)
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
 * and current user session or API token.
 *
 * Authentication order:
 * 1. Try session validation first (most common)
 * 2. If session fails, try API token validation
 *
 * Session validation uses Redis cache for fast lookups (5 min TTL),
 * falling back to database on cache miss.
 */
export async function createContext(opts: FetchCreateContextFnOptions): Promise<Context> {
  const { req } = opts;

  // Extract token from request
  const token = getToken(req.headers);

  if (!token) {
    return {
      db,
      session: null,
      apiToken: null,
      authType: null,
      scopes: [],
      sessionToken: null,
      headers: req.headers,
    };
  }

  // Try session validation first (most common case)
  const session = await validateSession(token);
  if (session) {
    return {
      db,
      session,
      apiToken: null,
      authType: "session",
      scopes: [], // Session auth has full access, scopes not used
      sessionToken: token,
      headers: req.headers,
    };
  }

  // Try API token validation
  const apiTokenData = await validateApiToken(token);
  if (apiTokenData) {
    // Create a synthetic session for compatibility with existing code
    const syntheticSession: SessionData = {
      session: {
        id: apiTokenData.token.id,
        userId: apiTokenData.user.id,
        tokenHash: "",
        expiresAt: apiTokenData.token.expiresAt ?? new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
        revokedAt: null,
        createdAt: apiTokenData.token.createdAt,
        lastActiveAt: apiTokenData.token.lastUsedAt ?? apiTokenData.token.createdAt,
        userAgent: null,
        ipAddress: null,
      },
      user: apiTokenData.user,
    };

    return {
      db,
      session: syntheticSession,
      apiToken: apiTokenData,
      authType: "api_token",
      scopes: (apiTokenData.token.scopes ?? []) as ApiTokenScope[],
      sessionToken: token,
      headers: req.headers,
    };
  }

  // Token provided but invalid
  return {
    db,
    session: null,
    apiToken: null,
    authType: null,
    scopes: [],
    sessionToken: null,
    headers: req.headers,
  };
}

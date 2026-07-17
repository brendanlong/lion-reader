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
import { extractBearerToken } from "@/server/auth/bearer";

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
   * Mutable response headers for the browser tRPC path (the fetch adapter merges
   * these into the HTTP response). Used to set/clear the httpOnly session cookie
   * on login/logout (see src/server/auth/session-cookie.ts). Absent on the
   * REST/OpenAPI path (that adapter doesn't supply it), where auth clients read
   * the token from the response body instead, so cookie writes there are no-ops.
   */
  resHeaders?: Headers;
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
  const bearerToken = extractBearerToken(headers.get("authorization"));
  if (bearerToken) {
    return bearerToken;
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
  // Present on the browser tRPC fetch path; undefined on the REST/OpenAPI path
  // (its adapter uses a Node res shim and doesn't pass resHeaders through).
  const resHeaders = opts.resHeaders as Headers | undefined;

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
      resHeaders,
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
      resHeaders,
    };
  }

  // Try API token validation.
  //
  // Note: OAuth 2.1 access tokens are intentionally NOT accepted here. They are
  // audience-bound to the MCP endpoint (`/api/mcp`, see validateAccessToken +
  // the RFC 8707 resource check there). The main tRPC/REST API is reachable only
  // via browser sessions and legacy API tokens.
  const apiTokenData = await validateApiToken(token);
  if (apiTokenData) {
    // Build a synthetic session so downstream code can read user data uniformly.
    // This does NOT grant full access: token requests carry the token's scopes
    // (below) and every protected procedure is either session-only or enforces a
    // scope via `scopedProtectedProcedure`. See src/server/trpc/trpc.ts.
    const syntheticSession: SessionData = {
      session: {
        id: apiTokenData.token.id,
        userId: apiTokenData.user.id,
        tokenHash: "",
        // Token scope enforcement uses `scopes` on the context (below), not this
        // synthetic session; session.scopes is the scoped-*session* concept,
        // which doesn't apply to API tokens.
        scopes: null,
        expiresAt: apiTokenData.token.expiresAt ?? new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
        revokedAt: null,
        createdAt: apiTokenData.token.createdAt,
        lastActiveAt: apiTokenData.token.lastUsedAt ?? apiTokenData.token.createdAt,
        userAgent: null,
        ipAddress: null,
      },
      user: {
        ...apiTokenData.user,
        groqApiKey: null, // Not cached for security; use getUserApiKeys() when needed
        anthropicApiKey: null, // Not cached for security; use getUserApiKeys() when needed
        cerebrasApiKey: null, // Not cached for security; use getUserApiKeys() when needed
      },
      hasGroqApiKey: !!apiTokenData.user.groqApiKey,
      hasAnthropicApiKey: !!apiTokenData.user.anthropicApiKey,
      hasCerebrasApiKey: !!apiTokenData.user.cerebrasApiKey,
    };

    return {
      db,
      session: syntheticSession,
      apiToken: apiTokenData,
      authType: "api_token",
      scopes: (apiTokenData.token.scopes ?? []) as ApiTokenScope[],
      sessionToken: token,
      headers: req.headers,
      resHeaders,
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
    resHeaders,
  };
}

/**
 * tRPC Context
 *
 * This module creates the context that is available to all tRPC procedures.
 * The context includes database access and session/API token information.
 */

import { type FetchCreateContextFnOptions } from "@trpc/server/adapters/fetch";
import { db, type Database } from "@/server/db";
import { validateSession, type SessionData } from "@/server/auth/session";
import { validateApiToken, type ApiTokenData } from "@/server/auth/api-token";
import { validateAppAccessToken } from "@/server/auth/app-token";
import { extractBearerToken } from "@/server/auth/bearer";
import type { OAuthScope } from "@/server/oauth/utils";
import type { User } from "@/server/db/schema";

// Re-export types for use in other modules
/**
 * Authentication type: a user session, an API token, or the first-party app's
 * OAuth access token (see src/server/auth/app-token.ts).
 */
export type AuthType = "session" | "api_token" | "app_token";

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
   * Empty array for session auth (full access), populated for tokens.
   */
  scopes: OAuthScope[];
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
 * Builds a session-shaped view of a token's user so downstream code can read
 * user data uniformly. This does NOT grant full access: token requests carry
 * the token's scopes, and every protected procedure is either session-only or
 * enforces a scope via `scopedProtectedProcedure`. See src/server/trpc/trpc.ts.
 */
function syntheticSession(
  user: User,
  token: { id: string; createdAt: Date; expiresAt: Date; lastActiveAt: Date }
): SessionData {
  return {
    session: {
      id: token.id,
      userId: user.id,
      tokenHash: "",
      // Token scope enforcement uses `scopes` on the context, not this synthetic
      // session; session.scopes is the scoped-*session* concept, which doesn't
      // apply to tokens.
      scopes: null,
      expiresAt: token.expiresAt,
      revokedAt: null,
      createdAt: token.createdAt,
      lastActiveAt: token.lastActiveAt,
      userAgent: null,
      ipAddress: null,
    },
    user: {
      ...user,
      groqApiKey: null, // Not cached for security; use getUserApiKeys() when needed
      anthropicApiKey: null,
      cerebrasApiKey: null,
      openrouterApiKey: null,
      deepinfraApiKey: null,
    },
    hasGroqApiKey: !!user.groqApiKey,
    hasAnthropicApiKey: !!user.anthropicApiKey,
    hasCerebrasApiKey: !!user.cerebrasApiKey,
    hasOpenrouterApiKey: !!user.openrouterApiKey,
    hasDeepinfraApiKey: !!user.deepinfraApiKey,
  };
}

/**
 * Creates the tRPC context for each request.
 * This is called for every request and provides access to the database
 * and current user session or API token.
 *
 * Authentication order:
 * 1. Try session validation first (most common)
 * 2. If session fails, try API token validation
 * 3. Then the first-party app's OAuth access token
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
  const apiTokenData = await validateApiToken(token);
  if (apiTokenData) {
    return {
      db,
      session: syntheticSession(apiTokenData.user, {
        id: apiTokenData.token.id,
        createdAt: apiTokenData.token.createdAt,
        expiresAt: apiTokenData.token.expiresAt ?? new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
        lastActiveAt: apiTokenData.token.lastUsedAt ?? apiTokenData.token.createdAt,
      }),
      apiToken: apiTokenData,
      authType: "api_token",
      scopes: (apiTokenData.token.scopes ?? []) as OAuthScope[],
      sessionToken: token,
      headers: req.headers,
      resHeaders,
    };
  }

  // Try the first-party app's OAuth access token. Other OAuth tokens (MCP
  // clients, Wallabag) are audience-bound elsewhere and rejected here.
  const appToken = await validateAppAccessToken(token);
  if (appToken) {
    const now = new Date();
    return {
      db,
      session: syntheticSession(appToken.user, {
        id: appToken.tokenId,
        createdAt: now,
        expiresAt: appToken.expiresAt,
        lastActiveAt: now,
      }),
      apiToken: null,
      authType: "app_token",
      scopes: appToken.scopes as OAuthScope[],
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

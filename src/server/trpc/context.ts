/**
 * tRPC Context
 *
 * This module creates the context that is available to all tRPC procedures.
 * The context includes database access and session/API token information.
 */

import { type FetchCreateContextFnOptions } from "@trpc/server/adapters/fetch";
import { db, type Database } from "@/server/db";
import type { SessionData } from "@/server/auth/session";
import type { ApiTokenData } from "@/server/auth/api-token";
import {
  authenticateCredential,
  getBearerOrSessionCookie,
  type Credential,
} from "@/server/auth/credential";
import { trackAndroidAppRequest } from "@/server/metrics/metrics";
import type { OAuthScope } from "@/server/oauth/utils";
import type { User } from "@/server/db/schema";

// Re-export types for use in other modules
/**
 * Authentication type: a user session, an API token, or the first-party app's
 * OAuth access token (see src/server/auth/credential.ts).
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
    user,
  };
}

/** The credential kinds tRPC and REST accept. */
export const TRPC_CREDENTIAL_KINDS = ["session", "api_token", "app_token"] as const;

export type TrpcCredential = Extract<Credential, { kind: (typeof TRPC_CREDENTIAL_KINDS)[number] }>;

async function authenticate(token: string | null): Promise<TrpcCredential | null> {
  const auth = await authenticateCredential(token, { accept: TRPC_CREDENTIAL_KINDS });
  return auth.ok ? auth.credential : null;
}

/**
 * Creates the tRPC context for each request: a browser session, an API token,
 * or the first-party app's OAuth token. Procedures enforce scopes and signup
 * confirmation (src/server/trpc/trpc.ts). `authenticated` is the request's
 * credential when the caller has already authenticated it.
 */
export async function createContext(
  opts: FetchCreateContextFnOptions,
  authenticated?: TrpcCredential
): Promise<Context> {
  const { req } = opts;
  // Present on the browser tRPC fetch path; undefined on the REST/OpenAPI path
  // (its adapter uses a Node res shim and doesn't pass resHeaders through).
  const resHeaders = opts.resHeaders as Headers | undefined;
  const base = { db, headers: req.headers, resHeaders };

  const token = getBearerOrSessionCookie(req.headers);
  const credential = authenticated ?? (await authenticate(token));
  if (!credential) {
    return {
      ...base,
      session: null,
      apiToken: null,
      authType: null,
      scopes: [],
      sessionToken: null,
    };
  }

  switch (credential.kind) {
    case "session":
      return {
        ...base,
        session: credential.session,
        apiToken: null,
        authType: "session",
        scopes: [], // Session auth has full access, scopes not used
        sessionToken: token,
      };
    case "api_token": {
      const { token: apiToken, user } = credential.apiToken;
      return {
        ...base,
        session: syntheticSession(user, {
          id: apiToken.id,
          createdAt: apiToken.createdAt,
          expiresAt: apiToken.expiresAt ?? new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
          lastActiveAt: apiToken.lastUsedAt ?? apiToken.createdAt,
        }),
        apiToken: credential.apiToken,
        authType: "api_token",
        scopes: apiToken.scopes as OAuthScope[],
        sessionToken: token,
      };
    }
    case "app_token": {
      trackAndroidAppRequest(req.headers.get("user-agent"));
      const now = new Date();
      return {
        ...base,
        session: syntheticSession(credential.oauthToken.user, {
          id: credential.oauthToken.tokenId,
          createdAt: now,
          expiresAt: credential.oauthToken.expiresAt,
          lastActiveAt: now,
        }),
        apiToken: null,
        authType: "app_token",
        scopes: credential.oauthToken.scopes as OAuthScope[],
        sessionToken: token,
      };
    }
  }
}

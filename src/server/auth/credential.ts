/**
 * Request credentials, for every surface: tRPC/REST, the streaming routes, the
 * Google Reader and Wallabag compat APIs, and MCP.
 *
 * A surface names the credential kinds it accepts. An OAuth access token's kind
 * comes from the client and audience it was minted for, never its scopes:
 * dynamic registration lets any client request any scope, so a scope-only gate
 * would let one resource's token be replayed at another (SECURITY.md §6).
 */

import { validateSession, type SessionData } from "@/server/auth/session";
import { validateApiToken, type ApiTokenData } from "@/server/auth/api-token";
import { extractBearerToken } from "@/server/auth/bearer";
import { SESSION_COOKIE_NAME } from "@/server/auth/session-cookie";
import { isSignupConfirmed } from "@/server/auth/confirmation";
import { validateAccessToken, type OAuthTokenData } from "@/server/oauth/service";
import { APP_CLIENT_ID, getAppResourceIdentifier } from "@/server/oauth/app-client";
import { getResourceIdentifier } from "@/server/oauth/config";
import {
  isOAuthAccessTokenFormat,
  isResourceForThisServer,
  OAUTH_SCOPES,
} from "@/server/oauth/utils";
import { WALLABAG_CLIENT_ID } from "@/server/wallabag/client";

interface CredentialBase {
  user: SessionData["user"];
  /** Null for a browser session, which has full access. */
  scopes: readonly string[] | null;
}

type SessionCredential<K> = CredentialBase & { kind: K; session: SessionData };
type OAuthCredential<K> = CredentialBase & { kind: K; oauthToken: OAuthTokenData };

export type Credential =
  /** A browser session (cookie or Bearer). */
  | SessionCredential<"session">
  /** A session restricted by its scopes: the Google Reader `ClientLogin` token. */
  | SessionCredential<"scoped_session">
  | (CredentialBase & { kind: "api_token"; apiToken: ApiTokenData })
  /** The first-party app's OAuth token, bound to the main-API audience. */
  | OAuthCredential<"app_token">
  /** A token from the Wallabag password grant. */
  | OAuthCredential<"wallabag_token">
  /** Any other OAuth client's token, bound to `/api/mcp`. */
  | OAuthCredential<"mcp_token">;

export type CredentialKind = Credential["kind"];

type OAuthKind = "app_token" | "wallabag_token" | "mcp_token";

function oauthTokenKind(token: OAuthTokenData): OAuthKind | null {
  if (token.clientId === APP_CLIENT_ID) {
    // The app client is only ever minted reader:full-access.
    return token.resource !== null &&
      isResourceForThisServer(token.resource, getAppResourceIdentifier()) &&
      token.scopes.includes(OAUTH_SCOPES.READER_FULL_ACCESS)
      ? "app_token"
      : null;
  }
  if (token.clientId === WALLABAG_CLIENT_ID) return "wallabag_token";
  // Tokens issued before audience binding have no resource.
  return token.resource === null || isResourceForThisServer(token.resource, getResourceIdentifier())
    ? "mcp_token"
    : null;
}

/** The credential a token is, if it's one of the accepted kinds. */
async function resolveCredential<K extends CredentialKind>(
  token: string,
  accept: readonly K[]
): Promise<Extract<Credential, { kind: K }> | null> {
  const accepts = (kind: CredentialKind): kind is K => (accept as readonly string[]).includes(kind);
  // `accept` is a K[], so each credential built below is of an accepted kind.
  const accepted = (credential: Credential) => credential as Extract<Credential, { kind: K }>;

  // An unprefixed credential still falls through to the OAuth lookup until #1955.
  if (!isOAuthAccessTokenFormat(token)) {
    if (accepts("session") || accepts("scoped_session")) {
      const session = await validateSession(token, { allowScoped: accepts("scoped_session") });
      if (session) {
        const { scopes } = session.session;
        const kind = scopes === null ? "session" : "scoped_session";
        if (!accepts(kind)) return null;
        return accepted({ kind, session, user: session.user, scopes });
      }
    }
    if (accepts("api_token")) {
      const apiToken = await validateApiToken(token);
      if (apiToken) {
        return accepted({
          kind: "api_token",
          apiToken,
          user: apiToken.user,
          scopes: apiToken.token.scopes,
        });
      }
    }
  }

  if (accepts("app_token") || accepts("wallabag_token") || accepts("mcp_token")) {
    const oauthToken = await validateAccessToken(token);
    const kind = oauthToken && oauthTokenKind(oauthToken);
    if (oauthToken && kind && accepts(kind)) {
      return accepted({ kind, oauthToken, user: oauthToken.user, scopes: oauthToken.scopes });
    }
  }

  return null;
}

export interface AuthenticateOptions<K extends CredentialKind> {
  accept: readonly K[];
  /** The credential must hold at least one of these, unless it has full access. */
  requiredScopes?: readonly string[];
  /** Reject a user who hasn't finished signup confirmation (`isSignupConfirmed`). */
  requireConfirmed?: boolean;
}

export type AuthResult<C extends Credential> =
  | { ok: true; credential: C }
  | { ok: false; reason: "unauthenticated" }
  | { ok: false; reason: "insufficient_scope" | "unconfirmed"; credential: C };

/**
 * Authenticates a request's token. Each surface maps a failure onto its own
 * error format (a 401 for `unauthenticated`, normally a 403 otherwise).
 */
export async function authenticateCredential<K extends CredentialKind>(
  token: string | null,
  { accept, requiredScopes, requireConfirmed = false }: AuthenticateOptions<K>
): Promise<AuthResult<Extract<Credential, { kind: K }>>> {
  const credential = token ? await resolveCredential(token, accept) : null;
  if (!credential) return { ok: false, reason: "unauthenticated" };

  const { scopes } = credential;
  if (requiredScopes && scopes !== null && !requiredScopes.some((s) => scopes.includes(s))) {
    return { ok: false, reason: "insufficient_scope", credential };
  }
  if (requireConfirmed && !isSignupConfirmed(credential.user)) {
    return { ok: false, reason: "unconfirmed", credential };
  }
  return { ok: true, credential };
}

/** The token from an `Authorization: Bearer` header, else the session cookie. */
export function getBearerOrSessionCookie(headers: Headers): string | null {
  const bearerToken = extractBearerToken(headers.get("authorization"));
  if (bearerToken) return bearerToken;

  const cookieHeader = headers.get("cookie");
  if (!cookieHeader) return null;
  const cookies = Object.fromEntries(
    cookieHeader.split("; ").map((c) => {
      const [key, ...value] = c.split("=");
      return [key, value.join("=")];
    })
  );
  return cookies[SESSION_COOKIE_NAME] || null;
}

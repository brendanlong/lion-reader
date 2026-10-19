/**
 * Shared plumbing for the social-login providers.
 *
 * `google.ts`, `apple.ts` and `discord.ts` each own their state blob's shape and Redis
 * key prefix and their user-info shape, and map their callback onto the provider-neutral
 * `OAuthFlow` and `ProviderIdentity` below. The one-time state storage, the
 * code-for-tokens step and the user-info fetch are identical across them and live here.
 */

import * as client from "openid-client";
import { redis } from "@/server/redis";
import { OAUTH_STATE_TTL_SECONDS } from "@/server/auth/oauth/state-cookie";
import type { OAuthLinkTarget } from "@/server/auth/oauth/config";

/** An authorization URL, and the `state` it carries for the callback to present. */
export interface OAuthAuthUrl {
  url: string;
  state: string;
}

/** The tokens a provider issued, as stored on `oauth_accounts`. */
export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string | null;
  expiresAt?: Date | null;
  /** Every scope the token carries, where the provider reports them. */
  scopes?: string[];
}

/** Who the provider says signed in, and the tokens it issued. */
export interface ProviderIdentity extends OAuthTokens {
  /** The provider's stable id for the account (`sub` / Discord user id). */
  providerAccountId: string;
  /** Absent when the provider sends none (Apple, after the first authorization). */
  email?: string;
  /** The provider's own claim that `email` is verified (SECURITY.md §4). */
  emailVerified: boolean;
}

/**
 * What a callback does with the identity, decided by the flow's Redis state blob.
 * `reauthorize` is Google's incremental authorization for Docs: it refreshes the
 * flow user's existing link and signs no one in.
 */
export type OAuthFlow =
  | { kind: "sign-in"; inviteToken?: string; returnPath?: string }
  | { kind: "link"; target: OAuthLinkTarget }
  | {
      kind: "reauthorize";
      userId: string;
      /** App path the callback returns to, on success or failure. */
      returnPath: string;
      /** False only where the state cookie can't be set; `google.ts` says why. */
      browserBound: boolean;
    };

/**
 * A callback whose state has been read but not yet used: the flow is known, the code
 * not yet exchanged. Split so the state-cookie check runs before the state is consumed
 * and before any token request (`beginOAuthCallback`).
 */
export interface PendingOAuthCallback {
  flow: OAuthFlow;
  /**
   * Consumes the state, then exchanges the authorization code and reads the
   * provider's identity.
   *
   * @throws OAuthStateError when another callback already consumed the state
   */
  complete(code: string): Promise<ProviderIdentity>;
}

/** What a sign-in or link flow's state blob carries. */
export interface SignInOrLinkState {
  /** Invite token for new user registration */
  inviteToken?: string;
  /** Where a sign-in returns the user, already passed through `safeRedirectPath` */
  returnPath?: string;
  /** Present when this flow is a link (see `OAuthLinkTarget`) */
  link?: OAuthLinkTarget;
}

export function signInOrLinkFlow(state: SignInOrLinkState): OAuthFlow {
  return state.link
    ? { kind: "link", target: state.link }
    : { kind: "sign-in", inviteToken: state.inviteToken, returnPath: state.returnPath };
}

/** The callback's `state` was never issued, has expired, or was already used. */
export class OAuthStateError extends Error {
  constructor() {
    super("Invalid or expired OAuth state");
    this.name = "OAuthStateError";
  }
}

/** Stores a flow's state blob under `key` (the provider's prefix + the `state` value). */
export async function storeOAuthState(key: string, data: object): Promise<void> {
  await redis.setex(key, OAUTH_STATE_TTL_SECONDS, JSON.stringify(data));
}

/**
 * Starts a callback from the state blob under `key`; `start` maps the blob to the flow
 * and the provider's code exchange.
 *
 * The blob is only read here. `complete` deletes it before exchanging the code and
 * fails if it is already gone, so two concurrent callbacks can't both use one state,
 * while a callback rejected before then (by the state-cookie check) can't burn the
 * state of the browser that owns it.
 *
 * @throws OAuthStateError when it is absent, expired or not JSON
 */
export async function beginOAuthCallback<T>(
  key: string,
  start: (data: T) => { flow: OAuthFlow; exchange(code: string): Promise<ProviderIdentity> }
): Promise<PendingOAuthCallback> {
  const value = await redis.get(key);
  if (!value) {
    throw new OAuthStateError();
  }
  let data: T;
  try {
    data = JSON.parse(value) as T;
  } catch {
    throw new OAuthStateError();
  }

  const { flow, exchange } = start(data);
  return {
    flow,
    async complete(code) {
      if ((await redis.del(key)) === 0) {
        throw new OAuthStateError();
      }
      return exchange(code);
    },
  };
}

/** GETs a provider's user-info endpoint with the access token as a bearer credential. */
export async function fetchUserInfo<T>(
  url: string,
  accessToken: string,
  provider: string
): Promise<T> {
  const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!response.ok) {
    throw new Error(`Failed to fetch ${provider} user info: ${await response.text()}`);
  }
  return (await response.json()) as T;
}

/**
 * Exchange an authorization code for tokens.
 *
 * `openid-client` reads the authorization response out of the callback URL (and derives
 * the `redirect_uri` it sends to the token endpoint from that URL) rather than taking
 * `code`/`state` as plain arguments. Our callbacks don't all arrive as a URL — Apple
 * uses a cross-site form POST — so we rebuild the canonical callback URL from the
 * registered redirect URI plus the values we were handed.
 *
 * `expectedState` is therefore compared against a `state` we just wrote ourselves and
 * can't fail; it's passed because omitting it makes the client *reject* a response that
 * carries `state` at all. The real binding is Redis + the `HttpOnly` cookie, which the
 * caller has already checked (`state-cookie.ts`).
 *
 * @param config - The provider's client configuration
 * @param redirectUri - The redirect URI registered with the provider
 * @param params - The `code`/`state` from the callback, plus the PKCE verifier if the
 *   authorization request used one
 */
export async function exchangeAuthorizationCode(
  config: client.Configuration,
  redirectUri: string,
  params: { code: string; state: string; codeVerifier?: string }
): Promise<client.TokenEndpointResponse> {
  const callbackUrl = new URL(redirectUri);
  callbackUrl.searchParams.set("code", params.code);
  callbackUrl.searchParams.set("state", params.state);

  return client.authorizationCodeGrant(config, callbackUrl, {
    pkceCodeVerifier: params.codeVerifier,
    expectedState: params.state,
  });
}

/**
 * Absolute expiry of an access token, from the token response's relative `expires_in`.
 * Undefined when the provider didn't say (the token then has no known expiry).
 */
export function accessTokenExpiresAt(tokens: client.TokenEndpointResponse): Date | undefined {
  return tokens.expires_in === undefined
    ? undefined
    : new Date(Date.now() + tokens.expires_in * 1000);
}

/**
 * The tokens an authorization-code response issued. `scopes` is undefined when the
 * response omits the list (Apple): the requested scopes would understate an earlier
 * grant, which Google reports because we set `include_granted_scopes` (#1803).
 */
export function tokensFromResponse(tokens: client.TokenEndpointResponse): OAuthTokens {
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: accessTokenExpiresAt(tokens),
    scopes: tokens.scope?.split(" ").filter(Boolean),
  };
}

/**
 * The `oauth_accounts` columns to write for freshly issued tokens, on insert or update.
 *
 * What the provider omits is not the same as what it cleared. A re-consent or a
 * returning sign-in usually returns no refresh token, and Apple reports no scope list,
 * while the stored ones still hold (#1803), so both are written only when present.
 * `expiresAt` is always written: it belongs to the access token in this response, and
 * keeping a stale one next to a fresh token would re-refresh forever (`?? null`,
 * because Drizzle drops `undefined` from `set()`).
 */
export function oauthTokenColumns(tokens: OAuthTokens): {
  accessToken: string;
  expiresAt: Date | null;
  refreshToken?: string;
  scopes?: string[];
} {
  return {
    accessToken: tokens.accessToken,
    expiresAt: tokens.expiresAt ?? null,
    ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
    ...(tokens.scopes !== undefined ? { scopes: tokens.scopes } : {}),
  };
}

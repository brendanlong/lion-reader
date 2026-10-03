/**
 * Shared token-endpoint plumbing for the social-login providers.
 *
 * `google.ts`, `apple.ts` and `discord.ts` each own their state blob's shape and Redis
 * key prefix and their user-info shape; the one-time state storage, the code-for-tokens
 * step and the user-info fetch are identical across them and live here.
 */

import * as client from "openid-client";
import { redis } from "@/server/redis";
import { OAUTH_STATE_TTL_SECONDS } from "@/server/auth/oauth/state-cookie";

/** Stores a flow's state blob under `key` (the provider's prefix + the `state` value). */
export async function storeOAuthState(key: string, data: object): Promise<void> {
  await redis.setex(key, OAUTH_STATE_TTL_SECONDS, JSON.stringify(data));
}

/**
 * Reads and deletes a state blob, so each state is usable once. Null when absent or
 * expired; `invalidJsonFallback` when the stored value isn't JSON.
 */
export async function consumeOAuthState<T>(
  key: string,
  invalidJsonFallback: T | null = null
): Promise<T | null> {
  const value = await redis.get(key);
  if (!value) {
    return null;
  }
  await redis.del(key);
  try {
    return JSON.parse(value) as T;
  } catch {
    return invalidJsonFallback;
  }
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
 * uses a cross-site form POST, and the tRPC callback mutations carry the pair as JSON —
 * so we rebuild the canonical callback URL from the registered redirect URI plus the
 * values we were handed.
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

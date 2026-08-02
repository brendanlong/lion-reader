/**
 * Shared token-endpoint plumbing for the social-login providers.
 *
 * `google.ts`, `apple.ts` and `discord.ts` each own their state/PKCE storage and their
 * user-info shape, but the code-for-tokens step is identical across them and lives here.
 */

import * as client from "openid-client";

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

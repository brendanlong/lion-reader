/**
 * The social-login providers, and what differs between them.
 *
 * Everything else about a flow is shared: starting one (`startOAuthFlow`) and the
 * callback (`handleOAuthCallback` in `callback-helpers.ts`), which every provider's
 * route hands its request to.
 */

import { createAppleAuthUrl, beginAppleCallback } from "./apple";
import { isProviderEnabled, PROVIDER_LABELS, type OAuthProviderName } from "./config";
import { createDiscordAuthUrl, beginDiscordCallback } from "./discord";
import { createGoogleAuthUrl, beginGoogleCallback } from "./google";
import { setOAuthStateCookie, type OAuthStateSameSite } from "./state-cookie";
import type { OAuthAuthUrl, PendingOAuthCallback, SignInOrLinkState } from "./token-exchange";
import { errors } from "@/server/errors";

interface SocialLoginProvider {
  createAuthUrl(options: SignInOrLinkState): Promise<OAuthAuthUrl>;
  /** Reads the callback's state (`beginOAuthCallback`); throws `OAuthStateError` for an unknown one. */
  beginCallback(state: string): Promise<PendingOAuthCallback>;
  /**
   * How the provider returns to us. `form_post` (Apple) is a cross-site POST: its
   * state cookie must be `SameSite=None` to be sent along (`state-cookie.ts`), and
   * its redirects 303 so the browser follows them with a GET.
   */
  responseMode: "query" | "form_post";
}

export const SOCIAL_LOGIN_PROVIDERS: Record<OAuthProviderName, SocialLoginProvider> = {
  google: {
    createAuthUrl: createGoogleAuthUrl,
    beginCallback: beginGoogleCallback,
    responseMode: "query",
  },
  apple: {
    createAuthUrl: createAppleAuthUrl,
    beginCallback: beginAppleCallback,
    responseMode: "form_post",
  },
  discord: {
    createAuthUrl: createDiscordAuthUrl,
    beginCallback: beginDiscordCallback,
    responseMode: "query",
  },
};

export function stateCookieSameSite(provider: OAuthProviderName): OAuthStateSameSite {
  return SOCIAL_LOGIN_PROVIDERS[provider].responseMode === "form_post" ? "none" : "lax";
}

/**
 * Start a sign-in or link flow from the browser tRPC path: mint the authorization
 * URL and bind its state to this browser with the state cookie (login CSRF, #1263),
 * so the returned `state` needs no client-side storage.
 *
 * @throws `oauthProviderNotConfigured` when the provider isn't configured
 */
export async function startOAuthFlow(
  resHeaders: Headers | undefined,
  provider: OAuthProviderName,
  options: SignInOrLinkState
): Promise<OAuthAuthUrl> {
  if (!isProviderEnabled(provider)) {
    throw errors.oauthProviderNotConfigured(PROVIDER_LABELS[provider]);
  }

  const result = await SOCIAL_LOGIN_PROVIDERS[provider].createAuthUrl(options);
  setOAuthStateCookie(resHeaders, result.state, stateCookieSameSite(provider));
  return result;
}

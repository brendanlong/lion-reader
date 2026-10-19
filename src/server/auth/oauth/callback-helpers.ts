/**
 * The social-login callback, shared by every provider's route handler.
 *
 * What the callback does with the provider identity is the flow's (`OAuthFlow`,
 * from the Redis state blob): sign in, link to the account that started the flow,
 * or re-authorize an existing link.
 */

import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { appUrl } from "@/server/config/env";
import { isSessionActive, startSession } from "@/server/auth/session";
import { db } from "@/server/db";
import { getAppErrorCode } from "@/server/errors";
import {
  clearOAuthStateCookie,
  oauthStateCookieMatches,
  readOAuthStateCookie,
} from "@/server/auth/oauth/state-cookie";
import { linkOAuthAccount, reauthorizeOAuthAccount } from "@/server/services/oauth-accounts";
import { processOAuthCallback } from "@/server/auth/oauth/callback";
import {
  isProviderEnabled,
  type OAuthLinkTarget,
  type OAuthProviderName,
} from "@/server/auth/oauth/config";
import { SOCIAL_LOGIN_PROVIDERS, stateCookieSameSite } from "@/server/auth/oauth/providers";
import {
  OAuthStateError,
  type OAuthFlow,
  type ProviderIdentity,
} from "@/server/auth/oauth/token-exchange";

/** The `?error=` the login page shows for each app error a sign-in can raise. */
const SIGN_IN_ERROR_PARAMS: Partial<Record<string, string>> = {
  INVITE_REQUIRED: "invite_required",
  INVITE_INVALID: "invite_invalid",
  INVITE_EXPIRED: "invite_expired",
  INVITE_ALREADY_USED: "invite_already_used",
  SIGNUP_PROVIDER_NOT_ALLOWED: "signup_provider_not_allowed",
  OAUTH_ALREADY_LINKED: "provider_already_linked",
};

/**
 * Which `?link_error=` the settings page should show. `linkOAuthAccount` is the
 * only thing that raises these, so each code has exactly one meaning here.
 */
function linkErrorParam(error: unknown): string {
  switch (getAppErrorCode(error)) {
    case "OAUTH_ALREADY_LINKED":
      return "provider_already_linked";
    case "OAUTH_CALLBACK_FAILED":
      return "already_linked";
    case "SESSION_REVOKE_FAILED":
      return "session_revoke_failed";
    default:
      return "callback_failed";
  }
}

type Redirect = (path: string) => NextResponse;

/** Every response clears the one-time state binding cookie (#1263), success or not. */
function redirector(provider: OAuthProviderName, appUrl: string): Redirect {
  const { responseMode } = SOCIAL_LOGIN_PROVIDERS[provider];
  const status = responseMode === "form_post" ? 303 : undefined;
  return (path) => {
    const response = NextResponse.redirect(`${appUrl}${path}`, status);
    clearOAuthStateCookie(response, stateCookieSameSite(provider));
    return response;
  };
}

async function readCallbackParams(
  request: NextRequest,
  responseMode: "query" | "form_post"
): Promise<{ code: string | null; state: string | null }> {
  if (responseMode === "query") {
    const params = request.nextUrl.searchParams;
    return { code: params.get("code"), state: params.get("state") };
  }
  const form = await request.formData();
  const value = (name: string) => {
    const entry = form.get(name);
    return typeof entry === "string" ? entry : null;
  };
  return { code: value("code"), state: value("state") };
}

/**
 * Handle a provider's redirect back to us: read the state, check it is bound to this
 * browser, consume it and exchange the code, then do what the flow says. Every failure is a
 * redirect: to the login page, or for a link or re-authorization to where that
 * flow returns.
 */
export async function handleOAuthCallback(
  request: NextRequest,
  provider: OAuthProviderName
): Promise<NextResponse> {
  const redirect = redirector(provider, appUrl);
  const loginError = (error: string) => redirect(`/login?error=${error}`);

  try {
    if (!isProviderEnabled(provider)) {
      return loginError("provider_not_configured");
    }

    const { responseMode, beginCallback } = SOCIAL_LOGIN_PROVIDERS[provider];
    const { code, state } = await readCallbackParams(request, responseMode);
    if (!code || !state) {
      return loginError("callback_failed");
    }

    const pending = await beginCallback(state);
    const { flow } = pending;

    // Bind the callback to the browser that started the flow (login CSRF, #1263).
    // Checked after reading the state, which is where the one exempt flow is recorded
    // (`OAuthFlow`), but before consuming it, so a request without the cookie can't
    // burn the owner's state, and before any token request.
    const browserBound = flow.kind !== "reauthorize" || flow.browserBound;
    if (browserBound && !oauthStateCookieMatches(readOAuthStateCookie(request), state)) {
      return loginError("invalid_state");
    }

    const identity = await pending.complete(code);

    switch (flow.kind) {
      case "link":
        return await completeLink(redirect, flow.target, provider, identity);
      case "reauthorize":
        return await completeReauthorize(redirect, appUrl, flow, provider, identity);
      case "sign-in":
        return await completeSignIn(redirect, request, flow.inviteToken, provider, identity);
    }
  } catch (error) {
    if (error instanceof OAuthStateError) {
      return loginError("invalid_state");
    }
    const appError = SIGN_IN_ERROR_PARAMS[getAppErrorCode(error) ?? ""];
    if (appError) {
      return loginError(appError);
    }
    logger.warn("OAuth callback failed", {
      provider,
      error: error instanceof Error ? error.message : String(error),
    });
    return loginError("callback_failed");
  }
}

/**
 * Attach the provider account to the `target` its authorization URL was minted for
 * (`OAuthLinkTarget` says why the account comes from there rather than from the
 * request), and return to settings. Never falls through to a sign-in (#1603).
 *
 * The target's session must still be live: adding a way to sign in is a
 * credential change, so a flow whose session was logged out or revoked in the
 * meantime is refused rather than applied.
 */
async function completeLink(
  redirect: Redirect,
  target: OAuthLinkTarget,
  provider: OAuthProviderName,
  identity: ProviderIdentity
): Promise<NextResponse> {
  if (!(await isSessionActive(target.sessionId))) {
    return redirect("/login?error=link_requires_login");
  }

  try {
    await linkOAuthAccount(db, {
      ...identity,
      userId: target.userId,
      currentSessionId: target.sessionId,
      provider,
    });
  } catch (error) {
    const errorParam = linkErrorParam(error);
    if (errorParam === "callback_failed") {
      logger.warn("Failed to link OAuth account", {
        provider,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (errorParam === "session_revoke_failed") {
      // The link itself landed; only signing the other devices out failed.
      return redirect(`/settings?linked=${provider}&link_error=${errorParam}`);
    }
    return redirect(`/settings?link_error=${errorParam}`);
  }

  return redirect(`/settings?linked=${provider}`);
}

/** Store the new tokens on the flow user's existing link; no session changes. */
async function completeReauthorize(
  redirect: Redirect,
  appUrl: string,
  flow: Extract<OAuthFlow, { kind: "reauthorize" }>,
  provider: OAuthProviderName,
  identity: ProviderIdentity
): Promise<NextResponse> {
  const updated = await reauthorizeOAuthAccount(db, { ...identity, userId: flow.userId, provider });
  if (updated) {
    return redirect(flow.returnPath);
  }

  // The browser came back with a provider account the flow user hasn't linked.
  logger.warn("OAuth re-authorization for an account the user hasn't linked", {
    provider,
    userId: flow.userId,
  });
  const url = new URL(flow.returnPath, appUrl);
  url.searchParams.set("error", "callback_failed");
  return redirect(url.pathname + url.search);
}

/** Sign in (or sign up) the account the identity picks, and set the session cookie. */
async function completeSignIn(
  redirect: Redirect,
  request: NextRequest,
  inviteToken: string | undefined,
  provider: OAuthProviderName,
  identity: ProviderIdentity
): Promise<NextResponse> {
  const { userId, isNewUser } = await processOAuthCallback({
    ...identity,
    provider,
    inviteToken,
  });

  // New users need to complete signup confirmation first. The completion page
  // broadcasts the success for PWAs.
  const redirectTo = isNewUser ? "/complete-signup" : "/all";
  const response = redirect(`/auth/oauth/complete?redirect=${encodeURIComponent(redirectTo)}`);
  // Set after `redirect` cleared the state cookie through `response.cookies`,
  // whose every `set` rewrites the Set-Cookie headers from its own list.
  await startSession(db, { userId, requestHeaders: request.headers, resHeaders: response.headers });

  return response;
}

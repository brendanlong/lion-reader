/**
 * OAuth `state` binding cookie (issue #1263).
 *
 * The OAuth `state` (and the Google PKCE verifier) is stored in Redis keyed by the
 * state value, so callback validation only proves "this state was issued by us" — it
 * is **not** tied to the browser that started the flow. That leaves a login-CSRF /
 * session-fixation hole: an attacker can run their own OAuth flow, obtain a valid
 * `code`+`state` for the attacker's account, and deliver the callback URL to a victim,
 * whose browser then logs into the **attacker's** account.
 *
 * We close it with the arctic/Lucia double-submit pattern: when the authorization URL
 * is generated we set a short-lived `HttpOnly` cookie holding the same `state`, and the
 * browser-facing callback route requires the cookie to match the `state` it received.
 * The attacker cannot set (or read) the victim's `HttpOnly` cookie, so a delivered
 * callback whose `state` doesn't match the victim's cookie is rejected. The binding —
 * not `SameSite` — is what provides the protection; `SameSite` is defense in depth.
 *
 * Set on the **browser tRPC path** only (the `{provider}AuthUrl` queries), via the
 * fetch adapter's `resHeaders`, exactly like the session cookie (see
 * `src/server/auth/session-cookie.ts`). REST/OpenAPI callers have no `resHeaders` and
 * no browser, so the setter no-ops for them (and their callbacks don't go through the
 * cookie-guarded redirect routes).
 *
 * ## Apple needs `SameSite=None`
 *
 * Google and Discord redirect back with a top-level **GET**, which carries a
 * `SameSite=Lax` cookie. Apple uses `response_mode=form_post`, i.e. a cross-site
 * **POST** from `appleid.apple.com`, and `SameSite=Lax` cookies are withheld from
 * cross-site POST navigations — a Lax cookie would never reach the Apple callback and
 * would break every Apple login. So the Apple state cookie is `SameSite=None; Secure`
 * (still `HttpOnly`, still bound the same way). `None` requires `Secure`; Apple OAuth
 * only runs over HTTPS anyway.
 */

import type { NextRequest, NextResponse } from "next/server";

export const OAUTH_STATE_COOKIE_NAME = "oauth_state";

/** Matches the 10-minute Redis TTL of the state / PKCE verifier. */
const OAUTH_STATE_MAX_AGE_SECONDS = 600;

/** `SameSite` policy: `lax` for GET-redirect providers, `none` for Apple's form_post. */
export type OAuthStateSameSite = "lax" | "none";

function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

/** `SameSite=None` must always be `Secure`; otherwise mirror the session cookie. */
function secure(sameSite: OAuthStateSameSite): boolean {
  return sameSite === "none" || isProduction();
}

function sameSiteAttr(sameSite: OAuthStateSameSite): string {
  return sameSite === "none" ? "None" : "Lax";
}

/**
 * Set the `HttpOnly` OAuth state cookie on the browser tRPC response.
 * No-op when `resHeaders` is absent (REST/OpenAPI path — no browser to bind).
 */
export function setOAuthStateCookie(
  resHeaders: Headers | undefined,
  state: string,
  sameSite: OAuthStateSameSite = "lax"
): void {
  if (!resHeaders) return;
  const secureSuffix = secure(sameSite) ? "; Secure" : "";
  resHeaders.append(
    "Set-Cookie",
    `${OAUTH_STATE_COOKIE_NAME}=${state}; Path=/; Max-Age=${OAUTH_STATE_MAX_AGE_SECONDS}; SameSite=${sameSiteAttr(sameSite)}; HttpOnly${secureSuffix}`
  );
}

/** Read the state binding cookie from an incoming callback request. */
export function readOAuthStateCookie(request: NextRequest): string | null {
  return request.cookies.get(OAUTH_STATE_COOKIE_NAME)?.value ?? null;
}

/** Expire the state binding cookie on a callback response (one-time use). */
export function clearOAuthStateCookie(
  response: NextResponse,
  sameSite: OAuthStateSameSite = "lax"
): void {
  response.cookies.set(OAUTH_STATE_COOKIE_NAME, "", {
    path: "/",
    maxAge: 0,
    sameSite,
    httpOnly: true,
    secure: secure(sameSite),
  });
}

/**
 * Verify the callback `state` is bound to this browser: the request must carry the
 * `HttpOnly` state cookie and it must equal the `state` the provider echoed back.
 * A missing cookie (attacker-delivered callback to a victim who never started a flow)
 * fails closed.
 */
export function oauthStateCookieMatches(
  cookieState: string | null,
  callbackState: string
): boolean {
  return typeof cookieState === "string" && cookieState.length > 0 && cookieState === callbackState;
}

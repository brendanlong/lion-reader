/**
 * Server-side session cookie management (issue #1088).
 *
 * The `session` cookie is `HttpOnly`: the raw token is never exposed to JS, so an
 * XSS on the (`dangerouslySetInnerHTML`-rendered) entry body cannot read it. The
 * server is the sole writer — it emits `Set-Cookie` on the browser tRPC response
 * via the fetch adapter's `resHeaders`, and the browser applies it. REST/OpenAPI
 * auth clients read the token from the response body instead and never see
 * `resHeaders`, so these helpers no-op there (guarded on `resHeaders` presence).
 *
 * There is no companion JS-readable cookie: the client detects a dead session
 * purely by reacting to an `UNAUTHORIZED` response inside the authenticated SPA
 * (see `<AuthErrorHandler>`), so nothing on the client needs to read login state.
 *
 * The cookie is `Secure` in production and `SameSite=Lax`, matching the OAuth
 * redirect flow in src/server/auth/oauth/callback-helpers.ts.
 */

export const SESSION_COOKIE_NAME = "session";

const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60; // 30 days

function secureSuffix(): string {
  return process.env.NODE_ENV === "production" ? "; Secure" : "";
}

/**
 * Set the httpOnly session cookie on the tRPC response.
 * No-op when `resHeaders` is absent (REST/OpenAPI path).
 */
export function setSessionCookie(resHeaders: Headers | undefined, token: string): void {
  if (!resHeaders) return;
  resHeaders.append(
    "Set-Cookie",
    `${SESSION_COOKIE_NAME}=${token}; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}; SameSite=Lax; HttpOnly${secureSuffix()}`
  );
}

/**
 * Clear the session cookie on the tRPC response.
 * No-op when `resHeaders` is absent (REST/OpenAPI path).
 */
export function clearSessionCookie(resHeaders: Headers | undefined): void {
  if (!resHeaders) return;
  resHeaders.append(
    "Set-Cookie",
    `${SESSION_COOKIE_NAME}=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly${secureSuffix()}`
  );
}

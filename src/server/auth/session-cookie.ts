/**
 * Server-side session cookie management (issue #1088).
 *
 * The `session` cookie is `HttpOnly`: the raw token is never exposed to JS, so an
 * XSS on the (`dangerouslySetInnerHTML`-rendered) entry body cannot read it. The
 * server is the sole writer — it emits `Set-Cookie` on the browser tRPC response
 * via the fetch adapter's `resHeaders` (or on the OAuth callback's redirect), and
 * the browser applies it. REST/OpenAPI auth clients read the token from the
 * response body instead and never see `resHeaders`, so these helpers no-op there
 * (guarded on `resHeaders` presence).
 *
 * There is no companion JS-readable cookie: the client detects a dead session
 * purely by reacting to an `UNAUTHORIZED` response inside the authenticated SPA
 * (see `<AuthErrorHandler>`), so nothing on the client needs to read login state.
 */

export const SESSION_COOKIE_NAME = "session";

/** Lifetime of a session: both its database expiry and the cookie that carries it. */
export const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

/** The only place the cookie's attributes are written (SECURITY.md §4). */
function sessionCookieHeader(value: string, maxAge: number): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${SESSION_COOKIE_NAME}=${value}; Path=/; Max-Age=${maxAge}; SameSite=Lax; HttpOnly${secure}`;
}

/**
 * Set the httpOnly session cookie on a response's headers.
 * No-op when `resHeaders` is absent (REST/OpenAPI path).
 */
export function setSessionCookie(resHeaders: Headers | undefined, token: string): void {
  resHeaders?.append("Set-Cookie", sessionCookieHeader(token, SESSION_MAX_AGE_SECONDS));
}

/**
 * Clear the session cookie on the tRPC response.
 * No-op when `resHeaders` is absent (REST/OpenAPI path).
 */
export function clearSessionCookie(resHeaders: Headers | undefined): void {
  resHeaders?.append("Set-Cookie", sessionCookieHeader("", 0));
}

/**
 * The session token a request's cookies carry. Takes anything with a Next.js-style
 * `get(name)`: `request.cookies` in a route handler or proxy, `await cookies()` in
 * a Server Component.
 */
export function getSessionCookie(cookies: {
  get(name: string): { value: string } | undefined;
}): string | null {
  return cookies.get(SESSION_COOKIE_NAME)?.value || null;
}

/**
 * Client-side session cookie management.
 *
 * The session cookie is deliberately NOT httpOnly so the SPA can set it after a
 * login/OAuth tRPC mutation (which returns the token in its response body) and
 * read it to gate client-side behaviour (see `hasSessionCookie`). This is a
 * documented, accepted trade-off — see "Session cookie" in docs/DESIGN.md.
 *
 * Because it is JS-accessible, transport confidentiality matters: every write
 * adds the `Secure` attribute whenever the page is served over HTTPS, so the
 * 30-day token is never transmitted over cleartext HTTP (e.g. a stray `http://`
 * link or a downgrade before HSTS pins). We key off `location.protocol` rather
 * than a build-time env flag so a Secure cookie is never emitted on a plain-HTTP
 * dev origin (browsers silently drop it), while any HTTPS origin gets it.
 */

const SESSION_COOKIE_NAME = "session";
const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60; // 30 days

/** True when the current page is served over HTTPS (so `Secure` cookies stick). */
function isSecureContext(): boolean {
  return typeof window !== "undefined" && window.location.protocol === "https:";
}

/**
 * Persist the session token in the `session` cookie.
 * Must match the cookie name read by the server tRPC/REST context.
 */
export function setSessionCookie(token: string): void {
  if (typeof document === "undefined") return;
  const secure = isSecureContext() ? "; secure" : "";
  document.cookie = `${SESSION_COOKIE_NAME}=${token}; path=/; max-age=${SESSION_MAX_AGE_SECONDS}; samesite=lax${secure}`;
}

/** Remove the session cookie (client-side logout). */
export function clearSessionCookie(): void {
  if (typeof document === "undefined") return;
  const secure = isSecureContext() ? "; secure" : "";
  document.cookie = `${SESSION_COOKIE_NAME}=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT; samesite=lax${secure}`;
}

/** Whether a session cookie is currently present. */
export function hasSessionCookie(): boolean {
  if (typeof document === "undefined") return false;
  return document.cookie.split(";").some((c) => c.trim().startsWith(`${SESSION_COOKIE_NAME}=`));
}

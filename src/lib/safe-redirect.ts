/**
 * Sanitizes a post-auth `redirect` target taken from a query parameter.
 *
 * Only same-origin, path-absolute destinations are allowed. Anything that could
 * navigate off-site is rejected in favor of `fallback`, which prevents an open
 * redirect (e.g. `?redirect=https://evil.com` or `?redirect=//evil.com`) from
 * bouncing a freshly-authenticated user to an attacker-controlled page.
 *
 * Allowed: `/all`, `/settings?tab=account`, `/tag/123#top`.
 * Rejected: absolute URLs (`https://…`, `http://…`, any `scheme:`),
 * protocol-relative (`//host`, `/\host`), and non-path values.
 */
export function safeRedirectPath(target: string | null | undefined, fallback = "/all"): string {
  if (!target) {
    return fallback;
  }

  // Must be a path starting with a single "/". Reject "//" and "/\" which browsers
  // treat as protocol-relative (off-site) URLs.
  if (!target.startsWith("/") || target.startsWith("//") || target.startsWith("/\\")) {
    return fallback;
  }

  // Defense-in-depth: reject anything the URL parser resolves to a different origin
  // (e.g. backslash tricks, embedded control characters). We resolve against an
  // arbitrary fixed origin and require it to stay there.
  try {
    const base = "https://lion-reader.internal";
    const resolved = new URL(target, base);
    if (resolved.origin !== base) {
      return fallback;
    }
    return `${resolved.pathname}${resolved.search}${resolved.hash}`;
  } catch {
    return fallback;
  }
}

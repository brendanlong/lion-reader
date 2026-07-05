/**
 * Client IP / client info extraction from request headers.
 *
 * The client IP is derived from a SINGLE trusted precedence so that every
 * consumer — rate limiting, session logging, auditing — agrees on which hop is
 * the real client. Getting this wrong is a security bug: the leftmost
 * `x-forwarded-for` entry is client-supplied and spoofable (Fly's proxy, like
 * most load balancers, *appends* the real client IP rather than replacing the
 * header), so keying anything on it lets a client forge its apparent origin.
 */

/**
 * Client information extracted from a request, used for session creation.
 */
export interface ClientInfo {
  userAgent?: string;
  ipAddress?: string;
}

/**
 * Derives the real client IP from request headers, using only trusted signals.
 *
 * Precedence:
 * 1. `Fly-Client-IP` — set by Fly's proxy for HTTP services; clients cannot
 *    override it (Fly strips/replaces any incoming value).
 * 2. The RIGHTMOST `x-forwarded-for` hop — the entry our trusted proxy appended.
 *    The leftmost entries are client-supplied and must never be trusted.
 * 3. `x-real-ip` — set by some proxies as the single client IP.
 *
 * @returns the client IP, or `undefined` when no trusted header is present
 *   (e.g. local development without a proxy).
 */
export function getClientIp(headers: Headers): string | undefined {
  const flyClientIp = headers.get("fly-client-ip");
  if (flyClientIp) {
    return flyClientIp;
  }

  const forwardedFor = headers.get("x-forwarded-for");
  if (forwardedFor) {
    const hops = forwardedFor
      .split(",")
      .map((hop) => hop.trim())
      .filter(Boolean);
    if (hops.length > 0) {
      return hops[hops.length - 1];
    }
  }

  const realIp = headers.get("x-real-ip");
  if (realIp) {
    return realIp;
  }

  return undefined;
}

/**
 * Extracts client info (user agent + IP address) for session creation/logging.
 */
export function extractClientInfo(headers: Headers): ClientInfo {
  return {
    userAgent: headers.get("user-agent") ?? undefined,
    ipAddress: getClientIp(headers),
  };
}

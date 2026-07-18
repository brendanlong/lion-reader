/**
 * CDN cache policy for the public marketing/auth pages we want a CDN to absorb
 * during a traffic spike (a Hacker News launch, etc.).
 *
 * These pages are all dynamically rendered — `/demo/*` reads `searchParams`, the
 * auth pages sit under `src/app/(auth)/layout.tsx`, which reads the session
 * cookie, and even the static legal pages (`/privacy`, `/terms`) inherit the
 * root layout's cookie read — so Next stamps them `private, no-store` by default
 * and a CDN caches nothing. This module opts the *shareable* renders back into
 * caching and is enforced at the custom-server layer (`applyPageCacheHeaders`),
 * because
 * `next.config.ts` `headers()` can neither reliably override Next's own
 * `Cache-Control` on a dynamic route nor vary on cookie presence.
 *
 * The decision is a pure function so it can be unit-tested
 * (`tests/unit/page-cache.test.ts`).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { SESSION_COOKIE_NAME } from "@/server/auth/session-cookie";

/**
 * Shareable render: browsers always revalidate (`max-age=0`) so a deploy is
 * picked up promptly, while a shared cache holds it for an hour and may serve
 * stale for a day while it refetches. `s-maxage` drives the CDN.
 */
const CACHEABLE = "public, max-age=0, s-maxage=3600, stale-while-revalidate=604800";

/** Per-session render (e.g. the signed-in redirect): never cache. */
const NO_STORE = "private, no-store";

export interface PageCachePolicy {
  /** The Cache-Control value to force onto the response. */
  cacheControl: string;
  /** Extra Vary token to merge into the response's Vary header, if any. */
  vary?: string;
  /**
   * True when this is the shareable render. Used to avoid stamping the cacheable
   * header onto an error status (a 404/500 shouldn't be cached for an hour).
   */
  cacheable: boolean;
}

/**
 * True if the raw `Cookie` request header carries a non-empty `session` cookie.
 * Mirrors the hand-rolled parse in `src/server/maintenance/server-gate.ts` so it
 * stays dependency-free on the hot path.
 */
export function cookieHeaderHasSession(cookieHeader: string | undefined): boolean {
  if (!cookieHeader) return false;
  for (const part of cookieHeader.split(/;\s*/)) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq) !== SESSION_COOKIE_NAME) continue;
    return part.slice(eq + 1).length > 0;
  }
  return false;
}

/**
 * Cache policy for a request, or `null` for every path we don't manage (leaving
 * Next's own `Cache-Control` intact).
 *
 * - `/demo/*`, `/privacy`, and `/terms` have no auth redirect anywhere in their
 *   subtree and no per-visitor content, so the HTML is identical for every
 *   visitor — always cacheable, no cookie dependence. Static assets that share
 *   the `/demo/` URL prefix (the `public/demo/*.png` screenshots embedded in
 *   demo entries) are excluded: this policy's `max-age=0` is meant for HTML,
 *   and stamping it on images forces browsers to revalidate every remounted
 *   `<img>`, which bypasses the synchronous memory/image cache and flashes alt
 *   text on each entry navigation. Skipping them leaves `next.config.ts`'s
 *   static-asset header (`max-age=86400`) in effect.
 * - `/login` and `/register` are rendered under the `(auth)` layout, which
 *   redirects a signed-in user to `/all` (or `/complete-signup`). The response
 *   body is therefore per-session: only the anonymous (no session cookie) render
 *   is shareable. A request carrying a session cookie gets `no-store` so the
 *   redirect is never cached, and `Vary: Cookie` declares the dependency to any
 *   intermediary cache. (Our CDN additionally bypasses cache whenever the
 *   session cookie is present, so this is defense in depth, not the sole gate.)
 *   The query params these pages accept (`?redirect`, `?registered`, `?error`,
 *   `?invite`) are read client-side after hydration, so the SSR HTML is
 *   query-independent and safe to share across query variants.
 */
export function pageCachePolicy(
  pathname: string,
  hasSessionCookie: boolean
): PageCachePolicy | null {
  if (
    pathname === "/demo" ||
    // Demo pages only — not the public/demo/* image assets that share the URL
    // prefix. Page routes are extensionless, so a dot in the final segment
    // means a static file; those keep the long-lived static-asset header.
    (pathname.startsWith("/demo/") && !/\.[^/]*$/.test(pathname)) ||
    pathname === "/privacy" ||
    pathname === "/terms"
  ) {
    return { cacheControl: CACHEABLE, cacheable: true };
  }
  if (pathname === "/login" || pathname === "/register") {
    return hasSessionCookie
      ? { cacheControl: NO_STORE, cacheable: false }
      : { cacheControl: CACHEABLE, vary: "Cookie", cacheable: true };
  }
  return null;
}

/**
 * Remove every case-insensitive occurrence of `name` from an explicit headers
 * value passed to `writeHead` (object form or the flat `[k, v, k, v, ...]` array
 * form), so it can't override the value we set via `setHeader`.
 */
function scrubInlineHeader(headers: Record<string, unknown> | unknown[], name: string): void {
  if (Array.isArray(headers)) {
    for (let i = 0; i < headers.length - 1; i += 2) {
      const key = headers[i];
      if (typeof key === "string" && key.toLowerCase() === name) {
        headers.splice(i, 2);
        i -= 2;
      }
    }
  } else {
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === name) delete headers[key];
    }
  }
}

/** Merge a Vary token into the response's existing Vary header, if not already present. */
function mergeVary(res: ServerResponse, token: string): void {
  const existing = res.getHeader("vary");
  if (!existing) {
    res.setHeader("Vary", token);
  } else if (
    typeof existing === "string" &&
    !existing.toLowerCase().includes(token.toLowerCase())
  ) {
    res.setHeader("Vary", `${existing}, ${token}`);
  }
}

/**
 * Force our Cache-Control (and Vary) onto the responses for the cacheable public
 * pages, overriding whatever Next set during dynamic rendering.
 *
 * Patches `res.writeHead` — the single point where headers are finalized before
 * flush — mirroring `maybeCompressResponse`. This wins whether Next set its
 * `Cache-Control` via `res.setHeader` (we overwrite it in the header map) or
 * inline in `writeHead` (we scrub it from the passed value). Must run before the
 * response starts, so call it before handing off to Next's request handler; the
 * compression wrapper's later `Vary: Accept-Encoding` append composes with our
 * `Vary: Cookie`.
 */
export function applyPageCacheHeaders(req: IncomingMessage, res: ServerResponse): void {
  const pathname = (req.url ?? "/").split("?")[0];
  const policy = pageCachePolicy(pathname, cookieHeaderHasSession(req.headers.cookie));
  if (!policy) return;

  const _writeHead = res.writeHead;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  res.writeHead = function (statusCode: number, ...args: any[]) {
    // Don't cache an error render (404/500) of a page whose happy path is
    // cacheable; leave Next's own no-store in place for those.
    if (!(policy.cacheable && statusCode >= 400)) {
      // Locate an explicit headers arg (writeHead(status, headers) or
      // writeHead(status, statusMessage, headers)) and scrub any Cache-Control
      // it carries so it can't override ours.
      const headers = (typeof args[0] === "string" ? args[1] : args[0]) as
        | Record<string, unknown>
        | unknown[]
        | undefined;
      if (headers && typeof headers === "object") {
        scrubInlineHeader(headers, "cache-control");
      }
      res.setHeader("Cache-Control", policy.cacheControl);
      if (policy.vary) mergeVary(res, policy.vary);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (_writeHead as any).apply(res, [statusCode, ...args]);
  } as typeof res.writeHead;
}

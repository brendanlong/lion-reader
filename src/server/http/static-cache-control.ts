/**
 * Neutralize the shared-cache lifetime Next.js stamps on statically-prerendered
 * responses.
 *
 * Next emits `Cache-Control: s-maxage=31536000` for fully-static prerenders —
 * both the `(public)` route group's HTML pages (demo/login/register/terms/
 * privacy) and their RSC (`.rsc` / `?_rsc=`) payloads. That invites a shared
 * cache to hold build-coupled content for a year, which is unsafe for us:
 *
 * - A cached HTML document references that build's hashed `/_next/static` chunks;
 *   after a deploy those hashes change and the old files are gone from the
 *   origin, so a stale page 404s its chunks and never hydrates. An RSC payload
 *   is worse — it's a Flight blob tied to the exact build and version-skews a
 *   newer client. (See docs/DEPLOYMENT.md, "Why HTML is not CDN-cached".)
 * - Our CDN is a Bunny pull zone wrapping the whole site that honors origin
 *   `Cache-Control`, so this lifetime is live, not theoretical.
 * - An edge-cached `/login` or `/register` would also bypass the maintenance
 *   gate in `scripts/server.ts` (#1318): the gate can't 503 a page served from
 *   the edge.
 *
 * We replace it with `private, no-cache`: `private` keeps it out of shared/CDN
 * caches entirely (fixing all three problems above), while `no-cache` still lets
 * the browser store a copy but forces revalidation against the origin before
 * every use — so after a deploy the browser always refetches fresh HTML rather
 * than booting a stale document (Next does NOT self-heal missing bootstrap
 * chunks on an initial document load), and during maintenance the revalidation
 * hits the 503 gate instead of serving a cached page.
 *
 * This runs in the custom server (the single hop every response passes through
 * after Next), so it wins regardless of how Next set the header.
 */
import type { ServerResponse } from "node:http";

/** The exact shared-cache lifetime Next stamps on fully-static prerenders. */
const STATIC_PRERENDER_SIGNATURE = /s-maxage=31536000/;

export const PUBLIC_PRERENDER_CACHE_CONTROL = "private, no-cache";

/** Rewrite Next's static-prerender Cache-Control; pass everything else through. */
function rewriteCacheControl(value: string): string {
  return STATIC_PRERENDER_SIGNATURE.test(value) ? PUBLIC_PRERENDER_CACHE_CONTROL : value;
}

/** Case-insensitively rewrite a `cache-control` entry inside a writeHead headers arg. */
function rewriteHeadersArg(headers: Record<string, unknown> | unknown[]): void {
  if (Array.isArray(headers)) {
    // Raw array: [key, value, key, value, ...]
    for (let i = 0; i < headers.length - 1; i += 2) {
      const key = headers[i];
      const value = headers[i + 1];
      if (
        typeof key === "string" &&
        key.toLowerCase() === "cache-control" &&
        typeof value === "string"
      ) {
        headers[i + 1] = rewriteCacheControl(value);
      }
    }
    return;
  }
  for (const key of Object.keys(headers)) {
    const value = headers[key];
    if (key.toLowerCase() === "cache-control" && typeof value === "string") {
      headers[key] = rewriteCacheControl(value);
    }
  }
}

/**
 * Wrap a response so any `Cache-Control` carrying Next's static-prerender
 * signature is rewritten before headers flush. Covers every channel a header
 * can arrive through: `res.setHeader('Cache-Control', ...)`, the batch
 * `res.setHeaders(Headers|Map)`, and headers passed to
 * `res.writeHead(status, headers)`.
 */
export function neutralizeStaticSharedCache(res: ServerResponse): void {
  const setHeader = res.setHeader.bind(res);
  res.setHeader = function (name: string, value: string | number | readonly string[]) {
    if (
      typeof name === "string" &&
      name.toLowerCase() === "cache-control" &&
      typeof value === "string"
    ) {
      return setHeader(name, rewriteCacheControl(value));
    }
    return setHeader(name, value);
  } as typeof res.setHeader;

  // Node 18.15+ batch setter. Rewrite the entry in place before delegating.
  // `Headers.get` is case-insensitive; a `Map` is not, so match its key by hand.
  if (typeof res.setHeaders === "function") {
    const setHeaders = res.setHeaders.bind(res);
    res.setHeaders = function (
      headers: Headers | Map<string, number | string | readonly string[]>
    ) {
      if (headers instanceof Map) {
        for (const [key, value] of headers) {
          if (key.toLowerCase() === "cache-control" && typeof value === "string") {
            headers.set(key, rewriteCacheControl(value));
          }
        }
      } else {
        const cc = headers.get("cache-control");
        if (cc !== null) headers.set("cache-control", rewriteCacheControl(cc));
      }
      return setHeaders(headers);
    } as typeof res.setHeaders;
  }

  const writeHead = res.writeHead.bind(res);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  res.writeHead = function (statusCode: number, ...args: any[]) {
    // writeHead(status, headers?) | writeHead(status, statusMessage, headers?)
    const headers = (typeof args[0] === "string" ? args[1] : args[0]) as
      | Record<string, unknown>
      | unknown[]
      | undefined;
    if (headers) rewriteHeadersArg(headers);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (writeHead as any)(statusCode, ...args);
  } as typeof res.writeHead;
}

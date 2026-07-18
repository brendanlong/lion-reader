/**
 * Unit tests for the CDN cache policy for public marketing/auth pages
 * (custom-server hot path). Covers the pure decision and the writeHead-patching
 * that forces the header over Next's dynamic-route no-store.
 */

import { describe, it, expect } from "vitest";
import { ServerResponse } from "node:http";
import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import {
  pageCachePolicy,
  cookieHeaderHasSession,
  applyPageCacheHeaders,
} from "../../src/server/http/page-cache";
import { SESSION_COOKIE_NAME } from "../../src/server/auth/session-cookie";

const CACHEABLE = "public, max-age=0, s-maxage=3600, stale-while-revalidate=604800";
const NO_STORE = "private, no-store";

describe("cookieHeaderHasSession", () => {
  it("is false with no cookie header", () => {
    expect(cookieHeaderHasSession(undefined)).toBe(false);
    expect(cookieHeaderHasSession("")).toBe(false);
  });

  it("detects a non-empty session cookie among others", () => {
    expect(cookieHeaderHasSession(`theme=dark; ${SESSION_COOKIE_NAME}=abc123; foo=bar`)).toBe(true);
    expect(cookieHeaderHasSession(`${SESSION_COOKIE_NAME}=abc123`)).toBe(true);
  });

  it("is false for an empty or absent session cookie", () => {
    expect(cookieHeaderHasSession(`${SESSION_COOKIE_NAME}=`)).toBe(false);
    expect(cookieHeaderHasSession("theme=dark; other=1")).toBe(false);
  });

  it("does not match a cookie whose name merely contains 'session'", () => {
    expect(cookieHeaderHasSession("admin_session=abc; oauth_state=xyz")).toBe(false);
  });
});

describe("pageCachePolicy", () => {
  it("makes /demo and its subtree cacheable regardless of cookie", () => {
    for (const path of ["/demo", "/demo/all", "/demo/tag/1", "/demo/subscription/2"]) {
      expect(pageCachePolicy(path, false)).toEqual({ cacheControl: CACHEABLE, cacheable: true });
      // Even a signed-in user gets the same shareable render — demo never redirects.
      expect(pageCachePolicy(path, true)).toEqual({ cacheControl: CACHEABLE, cacheable: true });
    }
  });

  it("makes the legal pages cacheable regardless of cookie", () => {
    for (const path of ["/privacy", "/terms"]) {
      // No per-visitor content and no auth redirect — shareable like /demo.
      expect(pageCachePolicy(path, false)).toEqual({ cacheControl: CACHEABLE, cacheable: true });
      expect(pageCachePolicy(path, true)).toEqual({ cacheControl: CACHEABLE, cacheable: true });
    }
  });

  it("caches the anonymous render of /login and /register with Vary: Cookie", () => {
    for (const path of ["/login", "/register"]) {
      expect(pageCachePolicy(path, false)).toEqual({
        cacheControl: CACHEABLE,
        vary: "Cookie",
        cacheable: true,
      });
    }
  });

  it("never caches /login or /register when a session cookie is present", () => {
    for (const path of ["/login", "/register"]) {
      expect(pageCachePolicy(path, true)).toEqual({ cacheControl: NO_STORE, cacheable: false });
    }
  });

  it("leaves demo static assets to the static-asset header", () => {
    // public/demo/*.png shares the /demo/ URL prefix with the demo pages, but
    // the page policy's max-age=0 on an image forces a revalidation on every
    // <img> remount — the browser can't reuse its memory/image cache
    // synchronously, so entry navigation flashes alt text before each paint.
    expect(pageCachePolicy("/demo/welcome.png", false)).toBeNull();
    expect(pageCachePolicy("/demo/welcome-og.png", true)).toBeNull();
  });

  it("does not match lookalike paths", () => {
    // /demofoo must not be treated as under /demo
    expect(pageCachePolicy("/demofoo", false)).toBeNull();
    expect(pageCachePolicy("/login/extra", false)).toBeNull();
    expect(pageCachePolicy("/privacyfoo", false)).toBeNull();
    expect(pageCachePolicy("/terms/extra", false)).toBeNull();
    expect(pageCachePolicy("/all", true)).toBeNull();
    expect(pageCachePolicy("/", true)).toBeNull();
  });
});

/** Build a fake req/res pair for the header-patching tests. */
function makeReqRes(url: string, cookie?: string): { req: IncomingMessage; res: ServerResponse } {
  const req = new IncomingMessage(new Socket());
  req.url = url;
  if (cookie) req.headers.cookie = cookie;
  const res = new ServerResponse(req);
  return { req, res };
}

describe("applyPageCacheHeaders", () => {
  it("forces the cacheable header on /demo, overriding Next's no-store", () => {
    const { req, res } = makeReqRes("/demo/all?entry=welcome");
    applyPageCacheHeaders(req, res);
    // Simulate Next stamping its dynamic-route default via setHeader.
    res.setHeader("Cache-Control", "private, no-store");
    res.writeHead(200);
    expect(res.getHeader("Cache-Control")).toBe(CACHEABLE);
  });

  it("scrubs an inline Cache-Control passed to writeHead", () => {
    const { req, res } = makeReqRes("/login");
    applyPageCacheHeaders(req, res);
    res.writeHead(200, { "Cache-Control": "no-store", "X-Other": "1" });
    expect(res.getHeader("Cache-Control")).toBe(CACHEABLE);
    expect(res.getHeader("Vary")).toBe("Cookie");
    expect(res.getHeader("X-Other")).toBe("1");
  });

  it("sends no-store for /login with a session cookie and does not add Vary", () => {
    const { req, res } = makeReqRes("/login", `${SESSION_COOKIE_NAME}=abc`);
    applyPageCacheHeaders(req, res);
    res.setHeader("Cache-Control", "public, max-age=60");
    res.writeHead(307);
    expect(res.getHeader("Cache-Control")).toBe(NO_STORE);
    expect(res.getHeader("Vary")).toBeUndefined();
  });

  it("merges Vary: Cookie with a pre-existing Vary", () => {
    const { req, res } = makeReqRes("/register");
    applyPageCacheHeaders(req, res);
    res.setHeader("Vary", "Accept-Encoding");
    res.writeHead(200);
    expect(res.getHeader("Vary")).toBe("Accept-Encoding, Cookie");
  });

  it("does not cache an error render of a cacheable page", () => {
    const { req, res } = makeReqRes("/demo/does-not-exist");
    applyPageCacheHeaders(req, res);
    res.setHeader("Cache-Control", "private, no-store");
    res.writeHead(404);
    expect(res.getHeader("Cache-Control")).toBe("private, no-store");
  });

  it("leaves unmanaged paths untouched", () => {
    const { req, res } = makeReqRes("/all");
    applyPageCacheHeaders(req, res);
    res.setHeader("Cache-Control", "private, no-store");
    res.writeHead(200);
    expect(res.getHeader("Cache-Control")).toBe("private, no-store");
  });
});

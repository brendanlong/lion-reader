/**
 * Next.js Proxy (middleware)
 *
 * This proxy has exactly two jobs, both claude.ai OAuth/MCP workarounds:
 *
 * 1. Method-splitting `/register` so claude.ai's root-path Dynamic Client
 *    Registration POST reaches the real DCR handler (see the big comment in
 *    `proxy()`).
 * 2. Trailing-slash normalization (`skipTrailingSlashRedirect` is enabled in
 *    next.config.ts): slashed OAuth/MCP-surface paths are REWRITTEN in place —
 *    server-to-server OAuth clients (claude.ai's connector uses python-httpx)
 *    don't follow redirects on POST, and claude.ai has been observed appending
 *    trailing slashes (anthropics/claude-ai-mcp#324); the known-working remote
 *    MCP servers all answer `POST /mcp/` directly. Every other path keeps
 *    Next's default behavior (a 308 redirect to the slashless URL).
 *
 * Route authentication is intentionally NOT handled here. It lives in one place:
 * the server-side layout guards — `src/app/(app)/layout.tsx` (via
 * `isAuthenticated()`) and `src/app/complete-signup/layout.tsx` — which validate
 * the real session (not just cookie presence) on every dynamic render, backed by
 * per-request tRPC/API session checks. A cookie-presence check here would be a
 * redundant *and weaker* second gate (it can't detect expired/revoked/forged
 * cookies), so we don't duplicate it. See issue #984, where the previous
 * proxy-level gate was found to be dead code.
 */

import { NextResponse, type NextRequest } from "next/server";

/**
 * True when a (slash-trimmed) path belongs to the OAuth/MCP surface, where
 * non-browser clients POST and a redirect would break the flow. `/register` is
 * only part of the surface for POST/OPTIONS (the DCR method-split below); GET
 * `/register/` is the human signup page and keeps the redirect.
 */
function isOauthMcpSurfacePath(pathname: string, method: string): boolean {
  if (pathname === "/api/mcp" || pathname === "/authorize" || pathname === "/token") {
    return true;
  }
  if (pathname.startsWith("/oauth/") || pathname.startsWith("/.well-known/")) {
    return true;
  }
  return pathname === "/register" && (method === "POST" || method === "OPTIONS");
}

/** True for the requests that `/register` method-splits to the DCR handler. */
function isDcrRegisterRequest(pathname: string, method: string): boolean {
  return pathname === "/register" && (method === "POST" || method === "OPTIONS");
}

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // ==========================================================================
  // Trailing-slash normalization (see file header). Next's own redirect is
  // disabled via `skipTrailingSlashRedirect`, so this must handle EVERY slashed
  // path: rewrite the OAuth/MCP surface in place, 308 the rest like Next would.
  // ==========================================================================
  if (pathname.length > 1 && pathname.endsWith("/")) {
    // A plain URL, not request.nextUrl.clone(): NextURL remembers that the
    // original path had a trailing slash and re-appends it when serialized,
    // silently undoing the rewrite.
    const url = new URL(request.url);
    url.pathname = pathname.replace(/\/+$/, "");
    if (isOauthMcpSurfacePath(url.pathname, request.method)) {
      if (isDcrRegisterRequest(url.pathname, request.method)) {
        url.pathname = "/oauth/register";
      }
      return NextResponse.rewrite(url);
    }
    return NextResponse.redirect(url, 308);
  }

  // ==========================================================================
  // HACK: claude.ai OAuth "root path" workaround — `/register` is METHOD-SPLIT.
  //
  //   GET      /register  ->  the human signup PAGE (normal; app/(auth)/register)
  //   POST     /register  ->  rewritten to the OAuth DCR handler at /oauth/register
  //   OPTIONS  /register  ->  same rewrite, so an in-browser MCP client's CORS
  //                           preflight for the DCR POST is answered (the DCR
  //                           route exports an OPTIONS handler; the signup page
  //                           does not). claude.ai itself is server-side and
  //                           sends no preflight, but this keeps browser clients
  //                           (MCP Inspector, playgrounds) working at the root.
  //
  // Why this exists: claude.ai's remote-MCP connector synthesizes OAuth
  // endpoints at the ORIGIN ROOT (/authorize, /token, /register) and ignores the
  // authorization_endpoint/token_endpoint/registration_endpoint we advertise in
  // RFC 8414 metadata. So its Dynamic Client Registration POST lands on
  // `/register`, not our real `/oauth/register`. (The /authorize + /token root
  // aliases live in src/app/{authorize,token}/route.ts.)
  //
  // This is deliberately ugly — ONE url doing two unrelated things by HTTP
  // method. We accept it only because (a) Next.js can't host a page and a route
  // handler at the same path, so we can't add a POST handler to /register
  // directly, and (b) nothing in the app POSTs to /register (signup submits via
  // tRPC to /api/trpc/*), so hijacking POST is safe. Anyone editing the /register
  // page or this proxy MUST keep that invariant.
  //
  // REMOVE THIS once claude.ai honors the advertised registration_endpoint:
  //   https://github.com/anthropics/claude-ai-mcp/issues/341  (tracking bug)
  //   https://github.com/anthropics/claude-ai-mcp/issues/82   (root-path synthesis)
  // ==========================================================================
  // The pathname guard is redundant with `config.matcher` today, but keeps the
  // rewrite correct on its own if the matcher is ever widened.
  if (isDcrRegisterRequest(pathname, request.method)) {
    const dcrUrl = request.nextUrl.clone();
    dcrUrl.pathname = "/oauth/register";
    return NextResponse.rewrite(dcrUrl);
  }

  // GET /register (and anything else) falls through to the normal route.
  return NextResponse.next();
}

/**
 * The proxy must see every path that can carry a trailing slash, because
 * `skipTrailingSlashRedirect` hands ALL slashed URLs to us — an unmatched
 * slashed path is served a broken empty 200 by Next. A matcher can't target
 * trailing slashes directly (Next normalizes the trailing slash out of matcher
 * patterns — verified against `/:path+/` and `/(.+)/`, whose slashed requests
 * bypassed the proxy), so match everything except Next's own assets. The
 * function body is a few string comparisons and no-ops for slashless paths, so
 * the per-request cost is negligible. Auth is still handled elsewhere (#984).
 */
export const config = {
  matcher: ["/((?!_next/).*)"],
};

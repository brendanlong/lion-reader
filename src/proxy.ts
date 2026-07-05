/**
 * Next.js Proxy (middleware)
 *
 * The ONLY job of this proxy is the claude.ai OAuth workaround: rewriting
 * POST/OPTIONS `/register` to the Dynamic Client Registration handler at
 * `/oauth/register` (see the big comment in `proxy()`). The `config.matcher`
 * below is scoped to `/register` so middleware doesn't run on any other request.
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

export function proxy(request: NextRequest) {
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
  if (
    request.nextUrl.pathname === "/register" &&
    (request.method === "POST" || request.method === "OPTIONS")
  ) {
    const dcrUrl = request.nextUrl.clone();
    dcrUrl.pathname = "/oauth/register";
    return NextResponse.rewrite(dcrUrl);
  }

  // GET /register (and anything else) falls through to the normal route.
  return NextResponse.next();
}

/**
 * Only run this proxy on `/register` — its sole purpose is the method-split
 * rewrite above. Everything else (auth included) is handled elsewhere, so there
 * is no reason to invoke middleware on other requests.
 */
export const config = {
  matcher: ["/register"],
};

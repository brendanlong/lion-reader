/**
 * Next.js Proxy (middleware)
 *
 * Two jobs, both scoped by `config.matcher` to the OAuth/MCP surface so the proxy
 * doesn't run on ordinary app traffic:
 *
 * 1. The claude.ai OAuth workaround: rewriting POST/OPTIONS `/register` to the
 *    Dynamic Client Registration handler at `/oauth/register` (see the big
 *    comment in `proxy()`).
 * 2. Optional request logging for debugging remote MCP connectors: when
 *    `LOG_MCP_REQUESTS=true`, one structured line per request to this surface
 *    (host, method, path, redacted query, user-agent, whether an Authorization
 *    header was present). This is how we see exactly what claude.ai sends — most
 *    importantly whether the authenticated `initialize` POST carries a Bearer
 *    token (issue #986 / the connector header-drop bug).
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
import { mcpConfig } from "@/server/config/env";

/**
 * Query params that are safe to log on the OAuth surface (client_id, PKCE
 * code_challenge, state, resource, scope are public/one-time — see the redaction
 * note in the connector-debugging guide). Anything else, notably an
 * authorization `code`, is redacted so it never lands in logs.
 */
const SAFE_QUERY_PARAMS = new Set([
  "client_id",
  "code_challenge",
  "code_challenge_method",
  "response_type",
  "redirect_uri",
  "resource",
  "scope",
  "state",
  "error",
]);

function redactedQuery(url: URL): string | undefined {
  if (url.searchParams.size === 0) return undefined;
  const out = new URLSearchParams();
  for (const [key, value] of url.searchParams) {
    out.set(key, SAFE_QUERY_PARAMS.has(key) ? value : "[redacted]");
  }
  return out.toString();
}

/**
 * Emit one structured line for a request to the OAuth/MCP surface. Uses
 * console.log directly (not the shared logger) to keep the middleware bundle from
 * pulling in Sentry; the JSON shape matches the logger's so it collates in
 * production log search.
 */
function logSurfaceRequest(request: NextRequest): void {
  console.log(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level: "info",
      message: "MCP surface request",
      service: "lion-reader",
      host: request.headers.get("host"),
      method: request.method,
      path: request.nextUrl.pathname,
      query: redactedQuery(request.nextUrl),
      userAgent: request.headers.get("user-agent"),
      // Boolean only — never log the token itself.
      hasAuthorization: request.headers.has("authorization"),
      contentType: request.headers.get("content-type"),
    })
  );
}

export function proxy(request: NextRequest) {
  if (mcpConfig.logRequests) {
    logSurfaceRequest(request);
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
 * Run the proxy on the OAuth/MCP surface only. This covers the `/register`
 * method-split above and every path a remote MCP connector touches (so the
 * optional request logging sees the whole handshake), while leaving ordinary
 * app traffic untouched.
 */
export const config = {
  matcher: [
    "/register",
    "/mcp",
    "/api/mcp",
    "/authorize",
    "/token",
    "/oauth/:path*",
    "/.well-known/:path*",
  ],
};

/**
 * Next.js Proxy (middleware)
 *
 * Three jobs:
 *
 * 1. The per-request Content-Security-Policy nonce (issue #1275): a locked-down
 *    `script-src` needs a fresh nonce on every response, which the static
 *    `headers()` config in `next.config.ts` can't produce. This is Next's
 *    documented CSP pattern: generate the nonce here and put the policy on the
 *    *request* headers — Next.js extracts the nonce from the forwarded
 *    `Content-Security-Policy` request header and stamps it onto its own
 *    framework/chunk `<script>` tags, and `src/app/(spa)/layout.tsx` reads `x-nonce`
 *    for the app's inline scripts — then set the same policy on the *response*.
 *    Policy contents and directive rationale live in `src/server/http/csp.ts`.
 *    Exception: the statically-prerendered public routes (`isPublicStaticPath`)
 *    get a static, relaxed CSP with no nonce (issue #1359) — their prerendered
 *    HTML can't carry a per-request nonce, and they render no untrusted HTML.
 * 2. The claude.ai OAuth workaround: rewriting POST/OPTIONS `/register` to the
 *    Dynamic Client Registration handler at `/oauth/register` (see the big
 *    comment in `proxy()`).
 * 3. Optional request logging for debugging remote MCP connectors: when
 *    `LOG_MCP_REQUESTS=true`, one structured line per request — host, method,
 *    path, redacted query, user-agent, whether an Authorization header was
 *    present. This is how we see exactly what claude.ai sends — most importantly
 *    whether the authenticated `initialize` POST carries a Bearer token (issue
 *    #986 / the connector header-drop bug), AND whether it hits any path we don't
 *    expect (the "wrong URL" / origin-root-fallback failure modes).
 *
 * The matcher runs on all requests (minus static assets) so job 3 can see
 * unexpected paths, but logging is gated: nothing is logged unless
 * `LOG_MCP_REQUESTS=true`, and even then only for (a) **every** request to the
 * dedicated MCP host (`MCP_HOST`) — full visibility on the debug host — and
 * (b) the OAuth/MCP surface paths on any host, so ordinary apex traffic (tRPC,
 * SSE, pages) stays out of the logs. When the flag is off the proxy is a
 * near-no-op that only performs the `/register` rewrite.
 *
 * Route authentication is intentionally NOT handled here. It lives in one place:
 * the server-side layout guards — `src/app/(spa)/(app)/layout.tsx` (via
 * `isAuthenticated()`) and `src/app/(spa)/complete-signup/layout.tsx` — which validate
 * the real session (not just cookie presence) on every dynamic render, backed by
 * per-request tRPC/API session checks. A cookie-presence check here would be a
 * redundant *and weaker* second gate (it can't detect expired/revoked/forged
 * cookies), so we don't duplicate it. See issue #984, where the previous
 * proxy-level gate was found to be dead code.
 */

import { NextResponse, type NextRequest } from "next/server";
import { mcpConfig } from "@/server/config/env";
import {
  buildContentSecurityPolicy,
  buildPublicContentSecurityPolicy,
  generateCspNonce,
} from "@/server/http/csp";

/**
 * Query params that are safe to log (client_id, PKCE code_challenge, state,
 * resource, scope are public/one-time — see the redaction note in the
 * connector-debugging guide). Anything else, notably an authorization `code`, is
 * redacted so it never lands in logs.
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

/**
 * OAuth/MCP surface paths, logged on ANY host (so apex-surface debugging works
 * even without MCP_HOST set). Requests to the MCP host are logged regardless of
 * path — see `shouldLog`.
 */
function isOAuthMcpSurfacePath(pathname: string): boolean {
  return (
    pathname === "/register" ||
    pathname === "/mcp" ||
    pathname === "/api/mcp" ||
    pathname === "/authorize" ||
    pathname === "/token" ||
    pathname === "/revoke" ||
    pathname.startsWith("/oauth/") ||
    pathname.startsWith("/.well-known/")
  );
}

/**
 * The statically-prerendered public routes (issue #1359): the `(public)` route
 * group — demo, login, register, terms, privacy. These get the relaxed static
 * CSP instead of the per-request nonce policy: generating a nonce would be
 * pointless (the prerendered HTML can't be stamped with it, so the nonce'd
 * policy would block every script on the page), and these pages render no
 * user-supplied HTML so the strict policy's backstop isn't needed. Keep this
 * list in sync with the contents of `src/app/(public)/` — a route added there
 * without an entry here gets the strict CSP and breaks (scripts blocked), the
 * safe failure direction.
 *
 * `POST`/`OPTIONS /register` is NOT public: it's the OAuth DCR rewrite below.
 */
function isPublicStaticPath(pathname: string): boolean {
  return (
    pathname === "/demo" ||
    pathname.startsWith("/demo/") ||
    pathname === "/login" ||
    pathname === "/register" ||
    pathname === "/terms" ||
    pathname === "/privacy"
  );
}

/** Strip a `:port` suffix and lower-case a Host header (leaves IPv6 literals). */
function normalizeHost(host: string): string {
  const lowered = host.trim().toLowerCase();
  if (lowered.startsWith("[")) return lowered;
  const colon = lowered.indexOf(":");
  return colon === -1 ? lowered : lowered.slice(0, colon);
}

function shouldLog(request: NextRequest): boolean {
  if (!mcpConfig.logRequests) return false;
  const host = request.headers.get("host");
  const mcpHost = mcpConfig.host;
  // Every request to the dedicated MCP host — including paths we don't expect.
  if (mcpHost && host && normalizeHost(host) === mcpHost) return true;
  // Otherwise only the OAuth/MCP surface, so apex user traffic isn't logged.
  return isOAuthMcpSurfacePath(request.nextUrl.pathname);
}

function redactedQuery(url: URL): string | undefined {
  if (url.searchParams.size === 0) return undefined;
  const out = new URLSearchParams();
  for (const [key, value] of url.searchParams) {
    out.set(key, SAFE_QUERY_PARAMS.has(key) ? value : "[redacted]");
  }
  return out.toString();
}

/**
 * Emit one structured line for a request. Uses console.log directly (not the
 * shared logger) to keep the middleware bundle from pulling in Sentry; the JSON
 * shape matches the logger's so it collates in production log search.
 */
function logRequest(request: NextRequest): void {
  console.log(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level: "info",
      message: "MCP debug request",
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
  if (shouldLog(request)) {
    logRequest(request);
  }

  // The service worker script deliberately gets NO CSP. A service worker's
  // fetches are governed by the CSP served on the worker script itself, and
  // the runtime-caching config in next.config.ts fetches cross-origin entry
  // images (and Google Fonts) from *inside* the worker — the app policy's
  // `connect-src` would silently break that caching. Pages control what the
  // SW can be asked to fetch via their own CSP.
  if (request.nextUrl.pathname === "/sw.js") {
    return NextResponse.next();
  }

  // Statically-prerendered public routes (issue #1359): no nonce — the
  // prerendered HTML was built without one — just the relaxed static CSP on
  // the response. Checked before the nonce flow but after the /register
  // method-split below can't apply (this matcher excludes POST/OPTIONS).
  if (
    isPublicStaticPath(request.nextUrl.pathname) &&
    !(
      request.nextUrl.pathname === "/register" &&
      (request.method === "POST" || request.method === "OPTIONS")
    )
  ) {
    const response = NextResponse.next();
    response.headers.set("Content-Security-Policy", buildPublicContentSecurityPolicy());
    return response;
  }

  // Per-request CSP nonce (issue #1275). `set` overwrites any client-supplied
  // `x-nonce`/`Content-Security-Policy` request header, so the values Next.js
  // and the layout read are always ours.
  const nonce = generateCspNonce();
  const csp = buildContentSecurityPolicy(nonce);
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);

  // ==========================================================================
  // HACK: claude.ai OAuth "root path" workaround — `/register` is METHOD-SPLIT.
  //
  //   GET      /register  ->  the human signup PAGE (normal; app/(public)/(auth)/register)
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
  let response: NextResponse;
  if (
    request.nextUrl.pathname === "/register" &&
    (request.method === "POST" || request.method === "OPTIONS")
  ) {
    const dcrUrl = request.nextUrl.clone();
    dcrUrl.pathname = "/oauth/register";
    response = NextResponse.rewrite(dcrUrl, { request: { headers: requestHeaders } });
  } else {
    // GET /register (and anything else) falls through to the normal route.
    response = NextResponse.next({ request: { headers: requestHeaders } });
  }
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

/**
 * Run the proxy on all requests except Next's build assets. The broad matcher
 * is what lets `LOG_MCP_REQUESTS` capture requests to unexpected paths on the
 * MCP host (the "wrong URL" failure mode), and it also puts the nonce'd CSP on
 * every response — including API/JSON responses, where a CSP is inert but
 * hardens any content-type-confusion angle. `_next/static`/`_next/image` are
 * excluded so middleware doesn't run per-asset (a CSP on those subresources is
 * meaningless); `/sw.js` is matched but bypassed inside `proxy()` (see there).
 */
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};

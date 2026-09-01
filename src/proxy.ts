/**
 * Next.js Proxy (middleware)
 *
 * Four jobs:
 *
 * 0. Session-aware redirects for `/` and the static auth pages
 *    (`maybeSessionRedirect`, issue #1359): anonymous visitors to `/` 307
 *    straight to the demo with no Next render; visitors with a *validated*
 *    session are bounced from `/`, `/login`, `/register` into the app. A UX
 *    redirect only — see the function comment for why this is not the #984
 *    auth gate.
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
 * 2. Optional request logging for debugging remote MCP connectors: when
 *    `LOG_MCP_REQUESTS=true`, one structured line per request — host, method,
 *    path, redacted query, user-agent, whether an Authorization header was
 *    present. This is how we see exactly what a connector sends — most
 *    importantly whether the authenticated `initialize` POST carries a Bearer
 *    token (issue #986 / the connector header-drop bug), AND whether it hits
 *    any path we don't expect (the "wrong URL" / origin-root-fallback failure
 *    modes — claude.ai has been observed synthesizing OAuth endpoints at the
 *    origin root instead of using the advertised metadata).
 *
 * The matcher runs on all requests (minus static assets) so job 2 can see
 * unexpected paths, but logging is gated: nothing is logged unless
 * `LOG_MCP_REQUESTS=true`, and even then only for the OAuth/MCP surface paths,
 * so ordinary traffic (tRPC, SSE, pages) stays out of the logs. When the flag
 * is off the proxy skips logging entirely.
 *
 * Route authentication is intentionally NOT handled here. It lives in one place:
 * the server-side layout guards — `src/app/(spa)/(app)/layout.tsx` (via
 * `isAuthenticated()`) and `src/app/(spa)/complete-signup/layout.tsx` — which validate
 * the real session (not just cookie presence) on every dynamic render, backed by
 * per-request tRPC/API session checks. A cookie-presence check here would be a
 * redundant *and weaker* second gate (it can't detect expired/revoked/forged
 * cookies), so we don't duplicate it. See issue #984, where the previous
 * proxy-level gate was found to be dead code. (`maybeSessionRedirect` is not
 * that gate: it protects nothing — it only *redirects* fully-validated
 * sessions away from the public pages, and falls through on anything else.)
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
 * OAuth/MCP surface paths worth logging. The root-path entries (`/register`,
 * `/mcp`, `/authorize`, `/token`, `/revoke`) are NOT served endpoints — they
 * stay in this list purely as diagnostics, because misbehaving connectors
 * (claude.ai) have been observed probing them instead of the advertised
 * endpoints, and a logged 404 there is exactly the evidence that identifies
 * that failure mode.
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

function shouldLog(request: NextRequest): boolean {
  if (!mcpConfig.logRequests) return false;
  // Only the OAuth/MCP surface, so ordinary user traffic isn't logged.
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

import { DEMO_LANDING_PATH } from "@/lib/routes";

/**
 * Session-aware redirects for `/` and the static auth pages (issue #1359).
 *
 * The login/register pages are statically prerendered, so the old
 * layout-level "already signed in → /all" redirect can't run there anymore;
 * and `/` was a dynamic page that existed only to issue a redirect. Both move
 * here. Cost profile is deliberately asymmetric: a visitor with no session
 * cookie — the flood case — costs one header check (and for `/`, an immediate
 * 307 with no Next render at all). Only when a session cookie is present do
 * we validate it (Redis-first, DB fallback — the modules load lazily so the
 * cookieless path never touches them).
 *
 * This is a UX redirect, NOT an auth gate — deliberately unlike the
 * proxy-level cookie-presence gate removed in #984: we fully validate the
 * session (a presence-only check would bounce a dead cookie to /all, whose
 * layout would bounce it straight back — a redirect loop), and on an invalid
 * session or any validation error we fall through to the page, where the
 * server-side layout guards remain the source of truth.
 *
 * `src/app/(spa)/page.tsx` keeps the same `/` logic as a fallback for the
 * validation-error fall-through; keep the two in sync.
 */
async function maybeSessionRedirect(request: NextRequest): Promise<NextResponse | null> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return null;
  }
  const { pathname } = request.nextUrl;
  const isRoot = pathname === "/";
  if (!isRoot && pathname !== "/login" && pathname !== "/register") {
    return null;
  }

  // Redirects carry no content, so the CSP is inert; set the static policy for
  // header consistency (these are all public-surface responses).
  const redirectTo = (target: string): NextResponse => {
    const response = NextResponse.redirect(new URL(target, request.url));
    response.headers.set("Content-Security-Policy", buildPublicContentSecurityPolicy());
    return response;
  };

  const sessionToken = request.cookies.get("session")?.value;
  if (sessionToken) {
    try {
      // Lazy imports keep the DB/Redis clients out of the cookieless hot path
      // (they initialize once, on the first request that carries a cookie).
      const [{ validateSession }, { sessionHomePath }] = await Promise.all([
        import("@/server/auth/session"),
        import("@/server/auth/confirmation"),
      ]);
      const session = await validateSession(sessionToken);
      if (session) {
        return redirectTo(sessionHomePath(session.user));
      }
    } catch (error) {
      // Validation infrastructure unavailable — fall through to the page (for
      // `/`, the dynamic fallback page retries with the same logic).
      console.error("Proxy session check failed:", error);
      return null;
    }
  }

  // No session (or an invalid one): the auth pages render normally; `/` goes
  // straight to the demo without invoking a Next render.
  return isRoot ? redirectTo(DEMO_LANDING_PATH) : null;
}

export async function proxy(request: NextRequest) {
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

  // Session-aware redirects for `/` and the static auth pages (see above).
  const sessionRedirect = await maybeSessionRedirect(request);
  if (sessionRedirect) {
    return sessionRedirect;
  }

  // Statically-prerendered public routes (issue #1359): no nonce — the
  // prerendered HTML was built without one — just the relaxed static CSP on
  // the response.
  if (isPublicStaticPath(request.nextUrl.pathname)) {
    const response = NextResponse.next();
    response.headers.set("Content-Security-Policy", buildPublicContentSecurityPolicy());
    // Override the year-long shared-cache lifetime Next stamps on fully-static
    // prerenders (`s-maxage=31536000`, on these pages AND their RSC payloads).
    // That HTML/RSC is build-coupled — it references per-deploy hashed chunks
    // that 404 after a deploy, and the RSC Flight payload version-skews a newer
    // client — so it must never be held by a shared cache across a deploy. Our
    // Bunny pull zone wraps the whole site and honors origin Cache-Control (and
    // keys on `_rsc`/`entry`), so an edge-cached `/login`/`/register` would also
    // bypass the maintenance gate in `scripts/server.ts` (#1318). Setting the
    // header here suppresses Next's default at the source: `sendRenderResult`
    // only stamps its own when none is already set (`!res.getHeader(...)`, in
    // next/dist/server/send-payload). `private` keeps it out of shared caches;
    // `no-cache` lets the browser hold a copy but revalidate, so a deploy can't
    // leave it booting a stale document (Next doesn't self-heal missing
    // bootstrap chunks) and a maintenance-time revalidation hits the 503 gate.
    response.headers.set("Cache-Control", "private, no-cache");
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

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

/**
 * Run the proxy on all requests except Next's build assets. The broad matcher
 * is what lets `LOG_MCP_REQUESTS` capture requests to unexpected paths (the
 * "wrong URL" failure mode), and it also puts the nonce'd CSP on every
 * response — including API/JSON responses, where a CSP is inert but hardens
 * any content-type-confusion angle. `_next/static`/`_next/image` are excluded
 * so middleware doesn't run per-asset (a CSP on those subresources is
 * meaningless); `/sw.js` is matched but bypassed inside `proxy()` (see there).
 */
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};

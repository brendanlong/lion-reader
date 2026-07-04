/**
 * Next.js Proxy
 *
 * Handles route protection and authentication redirects.
 *
 * This proxy checks for the presence of a session cookie on protected routes.
 * It performs a lightweight check (cookie existence only) - full validation happens
 * in tRPC/API routes.
 *
 * Unauthenticated users are redirected to the login page with the original path
 * preserved in a redirect parameter.
 */

import { NextResponse, type NextRequest } from "next/server";

/**
 * Paths that don't require authentication.
 * These paths either handle their own auth or are public.
 */
const PUBLIC_PATHS = [
  "/", // Landing page
  "/login",
  "/register",
  "/auth/oauth/callback",
  "/auth/oauth/complete",
  // Root-level OAuth endpoint aliases for claude.ai (which synthesizes OAuth
  // endpoints at the origin root — see src/app/authorize/route.ts). These handle
  // their own auth; /token is POSTed server-to-server with no session cookie, so
  // it must never be redirected to /login.
  "/authorize",
  "/token",
  "/oauth/", // OAuth authorization/token/register + consent handle their own auth
  "/api/", // All API routes handle their own auth
  "/_next/", // Next.js static files
  "/extension/", // Extension pages handle their own auth
  "/favicon.ico",
  "/robots.txt",
  "/onnx/", // ONNX WASM files for TTS
  "/manifest.json", // PWA manifest
  "/sw.js", // Service worker
  "/privacy", // Privacy policy page
  "/monitoring", // Sentry tunnel route
];

/**
 * Check if the given pathname is a public path that doesn't require auth.
 */
function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some((publicPath) => {
    // Exact match for specific files/routes
    if (publicPath === pathname) {
      return true;
    }
    // Prefix match for directories (paths ending with /)
    if (publicPath.endsWith("/") && pathname.startsWith(publicPath)) {
      return true;
    }
    return false;
  });
}

export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;

  // ==========================================================================
  // HACK: claude.ai OAuth "root path" workaround — `/register` is METHOD-SPLIT.
  //
  //   GET  /register  ->  the human signup PAGE (normal; app/(auth)/register)
  //   POST /register  ->  rewritten to the OAuth DCR handler at /oauth/register
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
  if (pathname === "/register" && request.method === "POST") {
    const dcrUrl = request.nextUrl.clone();
    dcrUrl.pathname = "/oauth/register";
    return NextResponse.rewrite(dcrUrl);
  }

  // Allow public paths without auth check
  if (isPublicPath(pathname)) {
    return NextResponse.next();
  }

  // Check for session cookie
  const sessionCookie = request.cookies.get("session");

  if (!sessionCookie?.value) {
    // Build the redirect URL with the original path preserved
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = "/login";
    // Preserve the full pathname + search params in the redirect param
    const redirectPath = search ? `${pathname}${search}` : pathname;
    loginUrl.searchParams.set("redirect", redirectPath);
    loginUrl.search = loginUrl.searchParams.toString();

    return NextResponse.redirect(loginUrl);
  }

  // Session cookie exists, allow the request to proceed
  // Full session validation happens in tRPC/API routes
  return NextResponse.next();
}

/**
 * Matcher configuration to exclude static assets.
 * This improves performance by not running the proxy on files that
 * don't need auth checks.
 */
export const config = {
  matcher: [
    /*
     * Match all request paths except:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - Static files with common extensions
     */
    "/((?!_next/static|_next/image|.*\\.(?:ico|png|jpg|jpeg|gif|svg|webp|woff|woff2|ttf|otf|eot|css|js|map)$).*)",
  ],
};

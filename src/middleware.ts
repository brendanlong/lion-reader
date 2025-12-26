/**
 * Next.js Middleware
 *
 * Handles route protection and authentication redirects.
 *
 * - Unauthenticated users accessing protected routes are redirected to /login
 * - Authenticated users accessing auth pages are redirected to /all
 */

import { NextResponse, type NextRequest } from "next/server";

/**
 * Routes that require authentication
 */
const PROTECTED_ROUTES = ["/all", "/starred", "/feed", "/entry", "/settings", "/subscribe"];

/**
 * Routes that should redirect authenticated users away
 */
const AUTH_ROUTES = ["/login", "/register"];

/**
 * Check if a path starts with any of the given prefixes
 */
function matchesRoute(path: string, routes: string[]): boolean {
  return routes.some((route) => path === route || path.startsWith(`${route}/`));
}

/**
 * Extract session token from cookies
 */
function getSessionToken(request: NextRequest): string | null {
  return request.cookies.get("session")?.value ?? null;
}

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const sessionToken = getSessionToken(request);
  const isAuthenticated = sessionToken !== null;

  // Skip middleware for API routes and static files
  if (pathname.startsWith("/api") || pathname.startsWith("/_next") || pathname.includes(".")) {
    return NextResponse.next();
  }

  // Redirect authenticated users away from auth pages
  if (isAuthenticated && matchesRoute(pathname, AUTH_ROUTES)) {
    const url = request.nextUrl.clone();
    url.pathname = "/all";
    return NextResponse.redirect(url);
  }

  // Redirect unauthenticated users to login for protected routes
  if (!isAuthenticated && matchesRoute(pathname, PROTECTED_ROUTES)) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    // Preserve the original destination for redirect after login
    url.searchParams.set("redirect", pathname);
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    /*
     * Match all request paths except:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     * - public files (images, etc)
     */
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};

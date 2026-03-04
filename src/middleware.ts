/**
 * Next.js Middleware
 *
 * Handles routing that can't be done with static route files.
 */

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export function middleware(request: NextRequest) {
  // Forward POST /register with JSON body to /oauth/register
  // This handles MCP clients that use the default OAuth path (/register)
  // instead of our /oauth/register endpoint discovered via metadata.
  // GET /register is NOT rewritten, so the user registration page still works.
  if (request.nextUrl.pathname === "/register" && request.method === "POST") {
    const contentType = request.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      return NextResponse.rewrite(new URL("/oauth/register", request.url));
    }
  }
}

export const config = {
  matcher: ["/register"],
};

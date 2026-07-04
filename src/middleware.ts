/**
 * TEMPORARY diagnostic request logging for the claude.ai MCP connector OAuth flow.
 *
 * claude.ai completes OAuth discovery against our server but then aborts with
 * "Couldn't register…" without any `POST /oauth/register` reaching our route
 * handlers. Route handlers only log when they're actually invoked, so a request
 * that 404s (e.g. an unexpected well-known path) or is dropped before routing is
 * invisible. This middleware logs EVERY request to the OAuth/MCP surface —
 * method, path, and source IP — so we can see exactly what claude.ai sends
 * (and from which IP: Anthropic's egress is 160.79.104.0/21) in the gap between
 * discovery succeeding and the connector giving up.
 *
 * Remove once the connector issue is diagnosed.
 */

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export function middleware(request: NextRequest) {
  try {
    console.log(
      JSON.stringify({
        level: "info",
        message: "oauth-mcp-debug request",
        service: "lion-reader",
        method: request.method,
        path: request.nextUrl.pathname,
        query: request.nextUrl.search || undefined,
        flyClientIp: request.headers.get("fly-client-ip") ?? undefined,
        xForwardedFor: request.headers.get("x-forwarded-for") ?? undefined,
        contentType: request.headers.get("content-type") ?? undefined,
        userAgent: request.headers.get("user-agent") ?? undefined,
        origin: request.headers.get("origin") ?? undefined,
      })
    );
  } catch {
    // Never let diagnostic logging break a request.
  }
  return NextResponse.next();
}

export const config = {
  // Only the OAuth/MCP discovery + registration + token surface, to avoid
  // logging normal app traffic. Catches 404s too (middleware runs before
  // routing), which is the whole point.
  matcher: ["/api/mcp", "/oauth/:path*", "/.well-known/:path*"],
};

/**
 * OAuth 2.0 Protected Resource Metadata (RFC 9728) — path-inserted location for
 * the `/mcp` endpoint served on the dedicated MCP host (`mcpConfig.host`).
 *
 * On that host the resource identifier is `https://{host}/mcp`, so RFC 9728 §3.1
 * clients construct the metadata URL by inserting the well-known segment before
 * the path: `/.well-known/oauth-protected-resource/mcp`. This is byte-for-byte
 * the location Notion/Linear/Sentry advertise, and the one our 401
 * `WWW-Authenticate` points at on the MCP host. The response is host-derived, so
 * this is only meaningful when requested with the MCP host's `Host` header.
 *
 * GET /.well-known/oauth-protected-resource/mcp
 */

import { NextRequest, NextResponse } from "next/server";
import { getProtectedResourceMetadata } from "@/server/oauth/config";
import { withMcpCorsHeaders, mcpCorsPreflight } from "@/server/http/cors";
import { logger } from "@/lib/logger";

export async function GET(request: NextRequest) {
  const host = request.headers.get("host");
  logger.info("OAuth protected resource metadata requested (mcp path-inserted)", { host });
  const metadata = getProtectedResourceMetadata(host);

  return withMcpCorsHeaders(
    NextResponse.json(metadata, {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=3600", // Cache for 1 hour
      },
    })
  );
}

export function OPTIONS() {
  return mcpCorsPreflight();
}

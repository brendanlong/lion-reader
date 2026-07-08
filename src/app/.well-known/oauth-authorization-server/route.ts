/**
 * OAuth 2.0 Authorization Server Metadata (RFC 8414)
 *
 * Returns metadata about the OAuth 2.0 authorization server.
 * Used by MCP clients to discover OAuth endpoints.
 *
 * GET /.well-known/oauth-authorization-server
 */

import { NextResponse } from "next/server";
import { getAuthorizationServerMetadata } from "@/server/oauth/config";
import { withMcpCorsHeaders, mcpCorsPreflight } from "@/server/http/cors";
import { checkRouteRateLimit } from "@/server/rate-limit";
import { logger } from "@/lib/logger";

export async function GET(request: Request) {
  const rateLimited = await checkRouteRateLimit(request, "oauth", { json: true });
  if (rateLimited) {
    return withMcpCorsHeaders(rateLimited);
  }

  logger.info("OAuth authorization server metadata requested");
  const metadata = getAuthorizationServerMetadata();

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

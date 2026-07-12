/**
 * OAuth 2.0 Authorization Server Metadata (RFC 8414)
 *
 * Returns metadata about the OAuth 2.0 authorization server.
 * Used by MCP clients to discover OAuth endpoints.
 *
 * GET /.well-known/oauth-authorization-server
 */

import { NextRequest, NextResponse } from "next/server";
import { getAuthorizationServerMetadata } from "@/server/oauth/config";
import { withMcpCorsHeaders, mcpCorsPreflight } from "@/server/http/cors";
import { logger } from "@/lib/logger";

export async function GET(request: NextRequest) {
  const host = request.headers.get("host");
  logger.info("OAuth authorization server metadata requested", { host });
  const metadata = getAuthorizationServerMetadata(host);

  return withMcpCorsHeaders(
    NextResponse.json(metadata, {
      headers: {
        "Content-Type": "application/json",
        // no-store: MCP clients (claude.ai) re-run discovery on every connect
        // and can act on a stale cached document mid-flow. None of the working
        // remote MCP servers (Linear, Sentry, Notion) allow caching here.
        "Cache-Control": "no-store",
      },
    })
  );
}

export function OPTIONS() {
  return mcpCorsPreflight();
}

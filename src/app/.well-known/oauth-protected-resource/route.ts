/**
 * OAuth 2.0 Protected Resource Metadata (RFC 9728)
 *
 * Returns metadata about the protected resource (MCP API).
 * Used by clients to discover authorization requirements.
 *
 * GET /.well-known/oauth-protected-resource
 */

import { NextResponse } from "next/server";
import { getProtectedResourceMetadata } from "@/server/oauth/config";
import { withMcpCorsHeaders, mcpCorsPreflight } from "@/server/http/cors";
import { logger } from "@/lib/logger";

export async function GET() {
  logger.info("OAuth protected resource metadata requested");
  const metadata = getProtectedResourceMetadata();

  return withMcpCorsHeaders(
    NextResponse.json(metadata, {
      headers: {
        "Content-Type": "application/json",
        // no-store: see .well-known/oauth-authorization-server/route.ts
        "Cache-Control": "no-store",
      },
    })
  );
}

export function OPTIONS() {
  return mcpCorsPreflight();
}

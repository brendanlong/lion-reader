/**
 * OAuth 2.0 Protected Resource Metadata (RFC 9728) — path-inserted location.
 *
 * Our resource identifier is `${issuer}/api/mcp` (it has a path), so RFC 9728
 * §3.1-compliant clients construct the metadata URL by inserting the well-known
 * segment before the path: `/.well-known/oauth-protected-resource/api/mcp`.
 * Serve the same metadata here as at the root location so both discovery styles
 * work. This is the URL the 401 `WWW-Authenticate` `resource_metadata` points
 * at (see `getProtectedResourceMetadataUrl`).
 *
 * GET /.well-known/oauth-protected-resource/api/mcp
 */

import { NextRequest, NextResponse } from "next/server";
import { getProtectedResourceMetadata } from "@/server/oauth/config";
import { withMcpCorsHeaders, mcpCorsPreflight } from "@/server/http/cors";
import { logger } from "@/lib/logger";

export async function GET(request: NextRequest) {
  const host = request.headers.get("host");
  logger.info("OAuth protected resource metadata requested (path-inserted)", { host });
  const metadata = getProtectedResourceMetadata(host);

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

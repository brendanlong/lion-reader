/**
 * OAuth 2.0 Protected Resource Metadata (RFC 9728) — path-inserted location.
 *
 * Our resource identifier is `${issuer}/api/mcp` (it has a path), so RFC 9728
 * §3.1-compliant clients construct the metadata URL by inserting the well-known
 * segment before the path: `/.well-known/oauth-protected-resource/api/mcp`.
 * Serve the same metadata here as at the root location so both discovery styles
 * work. (Our 401 `WWW-Authenticate` still points clients at the root URL.)
 *
 * GET /.well-known/oauth-protected-resource/api/mcp
 */

import { NextResponse } from "next/server";
import { getProtectedResourceMetadata } from "@/server/oauth/config";
import { withMcpCorsHeaders, mcpCorsPreflight } from "@/server/http/cors";
import { logger } from "@/lib/logger";

export async function GET() {
  logger.info("OAuth protected resource metadata requested (path-inserted)");
  const metadata = getProtectedResourceMetadata();

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

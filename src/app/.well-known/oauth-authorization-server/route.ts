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

export async function GET() {
  const metadata = getAuthorizationServerMetadata();

  return NextResponse.json(metadata, {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=3600", // Cache for 1 hour
    },
  });
}

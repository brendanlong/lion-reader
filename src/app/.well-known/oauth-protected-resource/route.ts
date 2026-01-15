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

export async function GET() {
  const metadata = getProtectedResourceMetadata();

  return NextResponse.json(metadata, {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=3600", // Cache for 1 hour
    },
  });
}

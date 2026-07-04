/**
 * OAuth 2.0 Dynamic Client Registration Endpoint (RFC 7591)
 *
 * Allows clients to dynamically register themselves with the authorization server.
 * Supports open registration (no initial access token required).
 *
 * POST /oauth/register
 */

import { NextRequest, NextResponse } from "next/server";
import { registerClient, type ClientRegistrationRequest } from "@/server/oauth/service";
import { checkRouteRateLimit } from "@/server/rate-limit";
import { withMcpCorsHeaders, mcpCorsPreflight } from "@/server/http/cors";
import { logger } from "@/lib/logger";

/**
 * Register a new OAuth client.
 * Wraps every response (including 429 / validation errors) in CORS headers so
 * in-browser MCP clients can read the result.
 */
export async function POST(request: NextRequest) {
  return withMcpCorsHeaders(await handleRegister(request));
}

export function OPTIONS() {
  return mcpCorsPreflight();
}

async function handleRegister(request: NextRequest): Promise<Response> {
  logger.info("OAuth client registration requested");

  // Dynamic Client Registration is open (no auth) per RFC 7591, so rate-limit by
  // IP to prevent anonymous client-spam. Uses the generous "oauth" bucket (not
  // "expensive") because MCP clients like claude.ai re-register on every connect
  // from a shared proxy egress; a strict shared bucket would 429 legitimate
  // registrations and surface as "Couldn't register".
  const rateLimited = await checkRouteRateLimit(request, "oauth", { json: true });
  if (rateLimited) {
    return rateLimited;
  }

  // Parse JSON body
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return NextResponse.json(
      {
        error: "invalid_request",
        error_description: "Content-Type must be application/json",
      },
      { status: 400 }
    );
  }

  let body: ClientRegistrationRequest;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      {
        error: "invalid_request",
        error_description: "Invalid JSON body",
      },
      { status: 400 }
    );
  }

  // Register the client
  const result = await registerClient(body);

  if (!result.success) {
    return NextResponse.json(result.error, {
      status: 400,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        Pragma: "no-cache",
      },
    });
  }

  // Return successful registration response with HTTP 201 Created
  return NextResponse.json(result.data, {
    status: 201,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      Pragma: "no-cache",
    },
  });
}

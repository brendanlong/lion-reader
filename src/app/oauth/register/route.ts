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

/**
 * Register a new OAuth client
 */
export async function POST(request: NextRequest) {
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

/**
 * OAuth 2.0 Token Revocation Endpoint (RFC 7009)
 *
 * Lets a client invalidate an access or refresh token it holds (e.g. on
 * disconnect). Advertised as `revocation_endpoint` in the RFC 8414 metadata —
 * every known-working remote MCP server (Linear, Sentry, Notion) advertises
 * one, and some MCP clients revoke on disconnect.
 *
 * POST /oauth/revoke
 */

import { type NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { resolveClient, revokeClientToken } from "@/server/oauth/service";
import { extractClientCredentials, clientSecretError } from "@/server/oauth/client-auth";
import { OAUTH_ERRORS, createOAuthError } from "@/server/oauth/utils";
import { checkRouteRateLimit } from "@/server/rate-limit";
import { withMcpCorsHeaders, mcpCorsPreflight } from "@/server/http/cors";

export async function POST(request: NextRequest) {
  return withMcpCorsHeaders(await handleRevoke(request));
}

export function OPTIONS() {
  return mcpCorsPreflight();
}

async function handleRevoke(request: NextRequest): Promise<Response> {
  // Same generous "oauth" bucket as the token endpoint: revocation is called
  // server-to-server from MCP client proxies with shared egress IPs.
  const rateLimitResponse = await checkRouteRateLimit(request, "oauth", { json: true });
  if (rateLimitResponse) return rateLimitResponse;

  // Parse form data or JSON body (mirrors the token endpoint)
  let body: Record<string, string>;
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/x-www-form-urlencoded")) {
    const formData = await request.formData();
    body = Object.fromEntries(Array.from(formData.entries()).map(([k, v]) => [k, String(v)]));
  } else if (contentType.includes("application/json")) {
    body = await request.json();
  } else {
    return NextResponse.json(
      createOAuthError(OAUTH_ERRORS.INVALID_REQUEST, "Unsupported content type"),
      { status: 400 }
    );
  }

  if (!body.token) {
    return NextResponse.json(
      createOAuthError(OAUTH_ERRORS.INVALID_REQUEST, "Missing token parameter"),
      { status: 400 }
    );
  }

  // Client authentication, same rules as the token endpoint
  const extracted = extractClientCredentials(request.headers.get("authorization"), body);
  if (!extracted.success) {
    return NextResponse.json(extracted.error, { status: extracted.status });
  }
  const { clientId, clientSecret } = extracted.credentials;

  if (!clientId) {
    return NextResponse.json(
      createOAuthError(OAUTH_ERRORS.INVALID_REQUEST, "Missing client_id parameter"),
      { status: 400 }
    );
  }

  const client = await resolveClient(clientId);
  if (!client) {
    return NextResponse.json(createOAuthError(OAUTH_ERRORS.INVALID_CLIENT, "Unknown client_id"), {
      status: 401,
    });
  }
  const secretError = clientSecretError(client, clientSecret);
  if (secretError) {
    return NextResponse.json(secretError, { status: 401 });
  }

  await revokeClientToken(clientId, body.token);
  logger.info("OAuth token revocation processed", { clientId });

  // RFC 7009 §2.2: 200 whether or not the token existed; the body is empty.
  return new NextResponse(null, {
    status: 200,
    headers: { "Cache-Control": "no-store", Pragma: "no-cache" },
  });
}

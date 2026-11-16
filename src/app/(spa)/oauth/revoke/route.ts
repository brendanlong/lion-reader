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
import { revokeClientToken } from "@/server/oauth/service";
import { authenticateClient, invalidRequest, parseOAuthBody } from "@/server/oauth/client-auth";
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

  const body = await parseOAuthBody(request);
  if (body instanceof Response) return body;

  if (!body.token) {
    return invalidRequest("Missing token parameter");
  }

  const client = await authenticateClient(request, body);
  if (client instanceof Response) return client;

  await revokeClientToken(client.clientId, body.token);
  logger.info("OAuth token revocation processed", { clientId: client.clientId });

  // RFC 7009 §2.2: 200 whether or not the token existed; the body is empty.
  return new NextResponse(null, {
    status: 200,
    headers: { "Cache-Control": "no-store", Pragma: "no-cache" },
  });
}

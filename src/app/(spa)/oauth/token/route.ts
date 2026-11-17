/**
 * OAuth 2.1 Token Endpoint
 *
 * Handles token exchange requests.
 * Supports:
 * - authorization_code grant with PKCE
 * - refresh_token grant with rotation
 *
 * POST /oauth/token
 */

import { type NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import {
  exchangeAuthorizationCode,
  rotateRefreshToken,
  type TokenPair,
} from "@/server/oauth/service";
import { authenticateClient, invalidRequest, parseOAuthBody } from "@/server/oauth/client-auth";
import { isValidCodeVerifier, OAUTH_ERRORS, createOAuthError } from "@/server/oauth/utils";
import { checkRouteRateLimit } from "@/server/rate-limit";
import { withMcpCorsHeaders, mcpCorsPreflight } from "@/server/http/cors";

/**
 * Token request via form data (standard OAuth).
 * Wraps every response in CORS headers so in-browser MCP clients can read it.
 */
export async function POST(request: NextRequest) {
  return withMcpCorsHeaders(await handleToken(request));
}

export function OPTIONS() {
  return mcpCorsPreflight();
}

async function handleToken(request: NextRequest): Promise<Response> {
  // Use the generous "oauth" bucket: token exchange runs server-to-server from
  // MCP client proxies (shared egress), so it must not share the strict
  // "expensive" per-IP bucket used by login/subscribe.
  const rateLimitResponse = await checkRouteRateLimit(request, "oauth", { json: true });
  if (rateLimitResponse) return rateLimitResponse;

  const body = await parseOAuthBody(request);
  if (body instanceof Response) return body;

  const grantType = body.grant_type;

  // Log what the client sent (no secrets) so token-exchange failures are
  // debuggable — grant type + which required params are present.
  // authenticateClient logs the client id, from the body or a Basic header.
  logger.info("OAuth token request", {
    grantType,
    hasClientSecret: !!body.client_secret,
    hasCode: !!body.code,
    hasCodeVerifier: !!body.code_verifier,
    hasRedirectUri: !!body.redirect_uri,
    hasRefreshToken: !!body.refresh_token,
  });

  if (grantType === "authorization_code") {
    return handleAuthorizationCodeGrant(request, body);
  } else if (grantType === "refresh_token") {
    return handleRefreshTokenGrant(request, body);
  } else {
    return NextResponse.json(
      createOAuthError(OAUTH_ERRORS.UNSUPPORTED_GRANT_TYPE, "Unsupported grant_type"),
      { status: 400 }
    );
  }
}

function tokenResponse(tokens: TokenPair): Response {
  return NextResponse.json(
    {
      access_token: tokens.accessToken,
      token_type: tokens.tokenType,
      expires_in: tokens.expiresIn,
      refresh_token: tokens.refreshToken,
      scope: tokens.scope,
    },
    { headers: { "Cache-Control": "no-store", Pragma: "no-cache" } }
  );
}

/**
 * Handle authorization_code grant type
 */
async function handleAuthorizationCodeGrant(request: NextRequest, body: Record<string, string>) {
  const { code, redirect_uri, code_verifier } = body;

  // Validate required parameters
  if (!code) {
    return invalidRequest("Missing code parameter");
  }

  if (!redirect_uri) {
    return invalidRequest("Missing redirect_uri parameter");
  }

  if (!code_verifier) {
    return invalidRequest("Missing code_verifier parameter (PKCE is required)");
  }

  // Validate code_verifier format
  if (!isValidCodeVerifier(code_verifier)) {
    return invalidRequest("Invalid code_verifier format");
  }

  const client = await authenticateClient(request, body);
  if (client instanceof Response) return client;

  const exchange = await exchangeAuthorizationCode(
    code,
    client.clientId,
    redirect_uri,
    code_verifier
  );

  if (!exchange) {
    return NextResponse.json(
      createOAuthError(
        OAUTH_ERRORS.INVALID_GRANT,
        "Invalid, expired, or already used authorization code"
      ),
      { status: 400 }
    );
  }

  const { tokens } = exchange;

  logger.info("OAuth token issued", {
    grantType: "authorization_code",
    clientId: client.clientId,
    userId: exchange.userId,
    scope: tokens.scope,
    resource: exchange.resource,
  });

  return tokenResponse(tokens);
}

/**
 * Handle refresh_token grant type
 */
async function handleRefreshTokenGrant(request: NextRequest, body: Record<string, string>) {
  const { refresh_token } = body;

  // Validate required parameters
  if (!refresh_token) {
    return invalidRequest("Missing refresh_token parameter");
  }

  const client = await authenticateClient(request, body);
  if (client instanceof Response) return client;

  const tokens = await rotateRefreshToken(refresh_token, client.clientId);

  if (!tokens) {
    return NextResponse.json(
      createOAuthError(OAUTH_ERRORS.INVALID_GRANT, "Invalid or expired refresh token"),
      { status: 400 }
    );
  }

  return tokenResponse(tokens);
}

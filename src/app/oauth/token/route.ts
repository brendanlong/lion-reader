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

import crypto from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import {
  resolveClient,
  validateAndConsumeAuthCode,
  createTokens,
  rotateRefreshToken,
  type ResolvedClient,
} from "@/server/oauth/service";
import {
  isValidCodeVerifier,
  hashToken,
  OAUTH_ERRORS,
  createOAuthError,
} from "@/server/oauth/utils";
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

  // Parse form data or JSON body
  let body: Record<string, string>;

  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/x-www-form-urlencoded")) {
    const formData = await request.formData();
    body = Object.fromEntries(Array.from(formData.entries()).map(([k, v]) => [k, String(v)]));
  } else if (contentType.includes("application/json")) {
    body = await request.json();
  } else {
    logger.warn("OAuth token request: unsupported content type", { contentType });
    return NextResponse.json(
      createOAuthError(OAUTH_ERRORS.INVALID_REQUEST, "Unsupported content type"),
      { status: 400 }
    );
  }

  const grantType = body.grant_type;

  // Log what the client sent (no secrets) so token-exchange failures are
  // debuggable — grant type + which required params are present.
  logger.info("OAuth token request", {
    grantType,
    clientId: body.client_id,
    hasCode: !!body.code,
    hasCodeVerifier: !!body.code_verifier,
    hasRedirectUri: !!body.redirect_uri,
    hasRefreshToken: !!body.refresh_token,
  });

  if (grantType === "authorization_code") {
    return handleAuthorizationCodeGrant(body);
  } else if (grantType === "refresh_token") {
    return handleRefreshTokenGrant(body);
  } else {
    return NextResponse.json(
      createOAuthError(OAUTH_ERRORS.UNSUPPORTED_GRANT_TYPE, "Unsupported grant_type"),
      { status: 400 }
    );
  }
}

/**
 * Validates client_secret for confidential clients.
 * Public clients (isPublic=true) don't require a secret.
 * Returns an error response if validation fails, or null if valid.
 */
function validateClientSecret(
  client: ResolvedClient,
  clientSecret: string | undefined
): NextResponse | null {
  if (client.isPublic) {
    return null; // Public clients don't need secret validation
  }
  if (!clientSecret) {
    return NextResponse.json(
      createOAuthError(
        OAUTH_ERRORS.INVALID_CLIENT,
        "Missing client_secret for confidential client"
      ),
      { status: 401 }
    );
  }
  const computedHash = hashToken(clientSecret);
  if (
    !client.clientSecretHash ||
    computedHash.length !== client.clientSecretHash.length ||
    !crypto.timingSafeEqual(Buffer.from(computedHash), Buffer.from(client.clientSecretHash))
  ) {
    return NextResponse.json(
      createOAuthError(OAUTH_ERRORS.INVALID_CLIENT, "Invalid client_secret"),
      { status: 401 }
    );
  }
  return null;
}

/**
 * Handle authorization_code grant type
 */
async function handleAuthorizationCodeGrant(body: Record<string, string>) {
  const { code, redirect_uri, client_id, code_verifier, client_secret } = body;

  // Validate required parameters
  if (!code) {
    return NextResponse.json(
      createOAuthError(OAUTH_ERRORS.INVALID_REQUEST, "Missing code parameter"),
      { status: 400 }
    );
  }

  if (!redirect_uri) {
    return NextResponse.json(
      createOAuthError(OAUTH_ERRORS.INVALID_REQUEST, "Missing redirect_uri parameter"),
      { status: 400 }
    );
  }

  if (!client_id) {
    return NextResponse.json(
      createOAuthError(OAUTH_ERRORS.INVALID_REQUEST, "Missing client_id parameter"),
      { status: 400 }
    );
  }

  if (!code_verifier) {
    return NextResponse.json(
      createOAuthError(
        OAUTH_ERRORS.INVALID_REQUEST,
        "Missing code_verifier parameter (PKCE is required)"
      ),
      { status: 400 }
    );
  }

  // Validate code_verifier format
  if (!isValidCodeVerifier(code_verifier)) {
    return NextResponse.json(
      createOAuthError(OAUTH_ERRORS.INVALID_REQUEST, "Invalid code_verifier format"),
      { status: 400 }
    );
  }

  // Resolve and authenticate client
  const client = await resolveClient(client_id);
  if (!client) {
    return NextResponse.json(createOAuthError(OAUTH_ERRORS.INVALID_CLIENT, "Unknown client_id"), {
      status: 401,
    });
  }
  const secretError = validateClientSecret(client, client_secret);
  if (secretError) return secretError;

  // Validate and consume authorization code
  const authCodeData = await validateAndConsumeAuthCode(
    code,
    client_id,
    redirect_uri,
    code_verifier
  );

  if (!authCodeData) {
    return NextResponse.json(
      createOAuthError(
        OAUTH_ERRORS.INVALID_GRANT,
        "Invalid, expired, or already used authorization code"
      ),
      { status: 400 }
    );
  }

  // Create tokens
  const tokens = await createTokens({
    clientId: client_id,
    userId: authCodeData.userId,
    scopes: authCodeData.scopes,
    resource: authCodeData.resource,
  });

  logger.info("OAuth token issued", {
    grantType: "authorization_code",
    clientId: client_id,
    userId: authCodeData.userId,
    scope: tokens.scope,
    resource: authCodeData.resource,
  });

  return NextResponse.json(
    {
      access_token: tokens.accessToken,
      token_type: tokens.tokenType,
      expires_in: tokens.expiresIn,
      refresh_token: tokens.refreshToken,
      scope: tokens.scope,
    },
    {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        Pragma: "no-cache",
      },
    }
  );
}

/**
 * Handle refresh_token grant type
 */
async function handleRefreshTokenGrant(body: Record<string, string>) {
  const { refresh_token, client_id, client_secret } = body;

  // Validate required parameters
  if (!refresh_token) {
    return NextResponse.json(
      createOAuthError(OAUTH_ERRORS.INVALID_REQUEST, "Missing refresh_token parameter"),
      { status: 400 }
    );
  }

  if (!client_id) {
    return NextResponse.json(
      createOAuthError(OAUTH_ERRORS.INVALID_REQUEST, "Missing client_id parameter"),
      { status: 400 }
    );
  }

  // Resolve and authenticate client
  const client = await resolveClient(client_id);
  if (!client) {
    return NextResponse.json(createOAuthError(OAUTH_ERRORS.INVALID_CLIENT, "Unknown client_id"), {
      status: 401,
    });
  }
  const secretError = validateClientSecret(client, client_secret);
  if (secretError) return secretError;

  // Rotate refresh token
  const tokens = await rotateRefreshToken(refresh_token, client_id);

  if (!tokens) {
    return NextResponse.json(
      createOAuthError(OAUTH_ERRORS.INVALID_GRANT, "Invalid or expired refresh token"),
      { status: 400 }
    );
  }

  return NextResponse.json(
    {
      access_token: tokens.accessToken,
      token_type: tokens.tokenType,
      expires_in: tokens.expiresIn,
      refresh_token: tokens.refreshToken,
      scope: tokens.scope,
    },
    {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        Pragma: "no-cache",
      },
    }
  );
}

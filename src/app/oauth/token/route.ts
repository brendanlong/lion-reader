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

import { NextRequest, NextResponse } from "next/server";
import {
  resolveClient,
  validateAndConsumeAuthCode,
  createTokens,
  rotateRefreshToken,
} from "@/server/oauth/service";
import { isValidCodeVerifier, OAUTH_ERRORS, createOAuthError } from "@/server/oauth/utils";

/**
 * Token request via form data (standard OAuth)
 */
export async function POST(request: NextRequest) {
  // Parse form data or JSON body
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

  const grantType = body.grant_type;

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
 * Handle authorization_code grant type
 */
async function handleAuthorizationCodeGrant(body: Record<string, string>) {
  const { code, redirect_uri, client_id, code_verifier } = body;

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

  // Resolve client
  const client = await resolveClient(client_id);
  if (!client) {
    return NextResponse.json(createOAuthError(OAUTH_ERRORS.INVALID_CLIENT, "Unknown client_id"), {
      status: 401,
    });
  }

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
  const { refresh_token, client_id } = body;

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

  // Resolve client
  const client = await resolveClient(client_id);
  if (!client) {
    return NextResponse.json(createOAuthError(OAUTH_ERRORS.INVALID_CLIENT, "Unknown client_id"), {
      status: 401,
    });
  }

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

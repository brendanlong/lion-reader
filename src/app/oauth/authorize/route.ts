/**
 * OAuth 2.1 Authorization Endpoint
 *
 * Handles the authorization request from OAuth clients.
 * Implements authorization code flow with PKCE.
 *
 * GET /oauth/authorize
 */

import { NextRequest, NextResponse } from "next/server";
import { validateSession } from "@/server/auth/session";
import {
  resolveClient,
  hasConsent,
  createAuthorizationCode,
  recordConsent,
} from "@/server/oauth/service";
import {
  isValidCodeChallenge,
  validateRedirectUri,
  isValidRedirectUriFormat,
  parseScopes,
  validateScopes,
  OAUTH_ERRORS,
  createOAuthError,
} from "@/server/oauth/utils";
import { getIssuer } from "@/server/oauth/config";

/**
 * Extracts session token from cookies.
 */
function getSessionToken(request: NextRequest): string | null {
  return request.cookies.get("session")?.value ?? null;
}

/**
 * Builds an error redirect URL with OAuth error parameters.
 */
function buildErrorRedirect(
  redirectUri: string,
  error: string,
  errorDescription: string,
  state?: string
): NextResponse {
  const url = new URL(redirectUri);
  url.searchParams.set("error", error);
  url.searchParams.set("error_description", errorDescription);
  if (state) {
    url.searchParams.set("state", state);
  }
  return NextResponse.redirect(url.toString());
}

/**
 * Builds a success redirect URL with authorization code.
 */
function buildSuccessRedirect(redirectUri: string, code: string, state?: string): NextResponse {
  const url = new URL(redirectUri);
  url.searchParams.set("code", code);
  if (state) {
    url.searchParams.set("state", state);
  }
  return NextResponse.redirect(url.toString());
}

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;

  // Extract required parameters
  const responseType = searchParams.get("response_type");
  const clientId = searchParams.get("client_id");
  const redirectUri = searchParams.get("redirect_uri");
  const codeChallenge = searchParams.get("code_challenge");
  const codeChallengeMethod = searchParams.get("code_challenge_method");
  const state = searchParams.get("state") ?? undefined;
  const scope = searchParams.get("scope") ?? undefined;
  const resource = searchParams.get("resource") ?? undefined;

  // Validate required parameters (before we can redirect errors)
  if (!clientId) {
    return NextResponse.json(
      createOAuthError(OAUTH_ERRORS.INVALID_REQUEST, "Missing client_id parameter"),
      { status: 400 }
    );
  }

  if (!redirectUri) {
    return NextResponse.json(
      createOAuthError(OAUTH_ERRORS.INVALID_REQUEST, "Missing redirect_uri parameter"),
      { status: 400 }
    );
  }

  // Validate redirect URI format before using it
  if (!isValidRedirectUriFormat(redirectUri)) {
    return NextResponse.json(
      createOAuthError(OAUTH_ERRORS.INVALID_REQUEST, "Invalid redirect_uri format"),
      { status: 400 }
    );
  }

  // Resolve the client
  const client = await resolveClient(clientId);
  if (!client) {
    return NextResponse.json(createOAuthError(OAUTH_ERRORS.INVALID_CLIENT, "Unknown client_id"), {
      status: 400,
    });
  }

  // Validate redirect_uri matches client's registered URIs
  if (!validateRedirectUri(redirectUri, client.redirectUris)) {
    return NextResponse.json(
      createOAuthError(OAUTH_ERRORS.INVALID_REQUEST, "redirect_uri not registered for this client"),
      { status: 400 }
    );
  }

  // From here on, we can redirect errors to the client

  // Validate response_type
  if (responseType !== "code") {
    return buildErrorRedirect(
      redirectUri,
      OAUTH_ERRORS.UNSUPPORTED_RESPONSE_TYPE,
      "Only response_type=code is supported",
      state
    );
  }

  // Validate PKCE parameters (required for OAuth 2.1)
  if (!codeChallenge) {
    return buildErrorRedirect(
      redirectUri,
      OAUTH_ERRORS.INVALID_REQUEST,
      "Missing code_challenge parameter (PKCE is required)",
      state
    );
  }

  if (codeChallengeMethod !== "S256") {
    return buildErrorRedirect(
      redirectUri,
      OAUTH_ERRORS.INVALID_REQUEST,
      "Only code_challenge_method=S256 is supported",
      state
    );
  }

  if (!isValidCodeChallenge(codeChallenge)) {
    return buildErrorRedirect(
      redirectUri,
      OAUTH_ERRORS.INVALID_REQUEST,
      "Invalid code_challenge format",
      state
    );
  }

  // Parse and validate scopes
  const requestedScopes = parseScopes(scope);
  const validScopes = validateScopes(
    requestedScopes.length > 0 ? requestedScopes : ["mcp"], // Default to mcp scope
    client.scopes
  );

  if (validScopes.length === 0) {
    return buildErrorRedirect(
      redirectUri,
      OAUTH_ERRORS.INVALID_SCOPE,
      "No valid scopes requested",
      state
    );
  }

  // Check if user is authenticated
  const sessionToken = getSessionToken(request);
  if (!sessionToken) {
    // Redirect to login with return URL
    const loginUrl = new URL("/login", getIssuer());
    loginUrl.searchParams.set("redirect", request.nextUrl.pathname + request.nextUrl.search);
    return NextResponse.redirect(loginUrl.toString());
  }

  const session = await validateSession(sessionToken);
  if (!session) {
    // Session invalid, redirect to login
    const loginUrl = new URL("/login", getIssuer());
    loginUrl.searchParams.set("redirect", request.nextUrl.pathname + request.nextUrl.search);
    return NextResponse.redirect(loginUrl.toString());
  }

  const userId = session.user.id;

  // Check if user has already consented
  const alreadyConsented = await hasConsent(userId, clientId, validScopes);

  if (!alreadyConsented) {
    // Redirect to consent page
    const consentUrl = new URL("/oauth/consent", getIssuer());
    // Pass all OAuth parameters to consent page
    consentUrl.searchParams.set("client_id", clientId);
    consentUrl.searchParams.set("redirect_uri", redirectUri);
    consentUrl.searchParams.set("scope", validScopes.join(" "));
    consentUrl.searchParams.set("code_challenge", codeChallenge);
    if (state) {
      consentUrl.searchParams.set("state", state);
    }
    if (resource) {
      consentUrl.searchParams.set("resource", resource);
    }
    return NextResponse.redirect(consentUrl.toString());
  }

  // User has consented, generate authorization code
  const code = await createAuthorizationCode({
    clientId,
    userId,
    redirectUri,
    scopes: validScopes,
    codeChallenge,
    resource,
    state,
  });

  return buildSuccessRedirect(redirectUri, code, state);
}

/**
 * Handle POST for consent approval (from consent page).
 */
export async function POST(request: NextRequest) {
  const formData = await request.formData();

  const clientId = formData.get("client_id") as string;
  const redirectUri = formData.get("redirect_uri") as string;
  const scope = formData.get("scope") as string;
  const codeChallenge = formData.get("code_challenge") as string;
  const state = formData.get("state") as string | undefined;
  const resource = formData.get("resource") as string | undefined;
  const action = formData.get("action") as string;

  // Validate required parameters
  if (!clientId || !redirectUri || !codeChallenge) {
    return NextResponse.json(
      createOAuthError(OAUTH_ERRORS.INVALID_REQUEST, "Missing required parameters"),
      { status: 400 }
    );
  }

  // Validate redirect URI format
  if (!isValidRedirectUriFormat(redirectUri)) {
    return NextResponse.json(
      createOAuthError(OAUTH_ERRORS.INVALID_REQUEST, "Invalid redirect_uri format"),
      { status: 400 }
    );
  }

  // Resolve and validate client
  const client = await resolveClient(clientId);
  if (!client || !validateRedirectUri(redirectUri, client.redirectUris)) {
    return NextResponse.json(createOAuthError(OAUTH_ERRORS.INVALID_CLIENT, "Invalid client"), {
      status: 400,
    });
  }

  // Check authentication
  const sessionToken = request.cookies.get("session")?.value;
  if (!sessionToken) {
    return NextResponse.json(createOAuthError(OAUTH_ERRORS.ACCESS_DENIED, "Not authenticated"), {
      status: 401,
    });
  }

  const session = await validateSession(sessionToken);
  if (!session) {
    return NextResponse.json(createOAuthError(OAUTH_ERRORS.ACCESS_DENIED, "Invalid session"), {
      status: 401,
    });
  }

  const userId = session.user.id;
  const scopes = scope ? scope.split(" ") : ["mcp"];

  // Handle user decision
  if (action === "deny") {
    return buildErrorRedirect(
      redirectUri,
      OAUTH_ERRORS.ACCESS_DENIED,
      "User denied authorization",
      state
    );
  }

  if (action === "approve") {
    // Record consent
    await recordConsent(userId, clientId, scopes);

    // Generate authorization code
    const code = await createAuthorizationCode({
      clientId,
      userId,
      redirectUri,
      scopes,
      codeChallenge,
      resource,
      state,
    });

    return buildSuccessRedirect(redirectUri, code, state);
  }

  return NextResponse.json(createOAuthError(OAUTH_ERRORS.INVALID_REQUEST, "Invalid action"), {
    status: 400,
  });
}

/**
 * OAuth 2.1 Service
 *
 * Database operations for OAuth authorization server.
 * Handles clients, authorization codes, tokens, and consent.
 */

import { eq, and, isNull, gt } from "drizzle-orm";
import { db } from "@/server/db";
import {
  oauthClients,
  oauthAuthorizationCodes,
  oauthAccessTokens,
  oauthRefreshTokens,
  oauthConsentGrants,
  users,
  type User,
} from "@/server/db/schema";
import { generateUuidv7 } from "@/lib/uuidv7";
import {
  generateToken,
  generateAuthorizationCode,
  hashToken,
  validatePkceS256,
  getAccessTokenExpiry,
  getRefreshTokenExpiry,
  getAuthCodeExpiry,
  isValidRedirectUriFormat,
  isResourceForThisServer,
  OAUTH_SCOPES,
  SUPPORTED_TOKEN_ENDPOINT_AUTH_METHODS,
} from "./utils";
import { getIssuer, getRegistrationClientUri, getResourceIdentifier } from "./config";
import { logger } from "@/lib/logger";
import { USER_AGENT } from "@/server/http/user-agent";
import { fetchWithSsrfProtection } from "@/server/http/ssrf";
import { readResponseBufferWithSizeLimit } from "@/server/http/fetch";

// ============================================================================
// Types
// ============================================================================

/**
 * Client metadata from Client ID Metadata Document
 */
export interface ClientMetadata {
  client_id: string;
  client_name?: string;
  redirect_uris: string[];
  grant_types?: string[];
  scope?: string;
}

/**
 * Resolved client information (from DB or CIMD)
 */
export interface ResolvedClient {
  clientId: string;
  name: string;
  redirectUris: string[];
  grantTypes: string[];
  scopes: string[] | null;
  isPublic: boolean;
  clientSecretHash: string | null;
  fromDatabase: boolean;
}

/**
 * Token pair returned after authorization
 */
export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  tokenType: "Bearer";
  expiresIn: number;
  scope: string;
}

/**
 * OAuth access token data for validation
 */
export interface OAuthTokenData {
  userId: string;
  clientId: string;
  scopes: string[];
  resource: string | null;
  user: User;
}

// ============================================================================
// Client Resolution
// ============================================================================

/**
 * Resolves a client by ID.
 * First checks the database, then fetches CIMD if the ID is a URL.
 */
export async function resolveClient(clientId: string): Promise<ResolvedClient | null> {
  // First, try to find in database
  const dbClient = await db
    .select()
    .from(oauthClients)
    .where(eq(oauthClients.clientId, clientId))
    .limit(1);

  if (dbClient.length > 0) {
    const client = dbClient[0];
    return {
      clientId: client.clientId,
      name: client.name,
      redirectUris: client.redirectUris,
      grantTypes: client.grantTypes,
      scopes: client.scopes,
      isPublic: client.isPublic,
      clientSecretHash: client.clientSecretHash,
      fromDatabase: true,
    };
  }

  // If clientId is a URL, try to fetch Client ID Metadata Document
  if (clientId.startsWith("https://")) {
    try {
      const metadata = await fetchClientMetadata(clientId);
      if (metadata) {
        return {
          clientId: metadata.client_id,
          name: metadata.client_name ?? "Unknown Application",
          redirectUris: metadata.redirect_uris,
          grantTypes: metadata.grant_types ?? ["authorization_code", "refresh_token"],
          scopes: metadata.scope ? metadata.scope.split(" ") : null,
          isPublic: true, // CIMD clients are always public
          clientSecretHash: null,
          fromDatabase: false,
        };
      }
    } catch (error) {
      console.error("Failed to fetch client metadata:", error);
    }
  }

  return null;
}

/**
 * Timeout for Client ID Metadata Document fetches (10 seconds).
 */
const CLIENT_METADATA_TIMEOUT_MS = 10000;

/**
 * Maximum Client ID Metadata Document size (256 KiB — real documents are tiny).
 */
const CLIENT_METADATA_MAX_BYTES = 256 * 1024;

/**
 * Fetches Client ID Metadata Document from URL.
 *
 * The URL is an arbitrary client_id reachable via unauthenticated
 * /oauth/authorize requests, so the fetch is SSRF-protected, time-limited,
 * and size-limited.
 */
async function fetchClientMetadata(url: string): Promise<ClientMetadata | null> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), CLIENT_METADATA_TIMEOUT_MS);

  try {
    const response = await fetchWithSsrfProtection(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": USER_AGENT,
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      return null;
    }

    const body = await readResponseBufferWithSizeLimit(response, CLIENT_METADATA_MAX_BYTES, url);
    const metadata = JSON.parse(body.toString()) as ClientMetadata;

    // Validate required fields
    if (!metadata.client_id || !metadata.redirect_uris || !Array.isArray(metadata.redirect_uris)) {
      return null;
    }

    // Ensure client_id matches the URL
    if (metadata.client_id !== url) {
      return null;
    }

    return metadata;
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

// ============================================================================
// Authorization Codes
// ============================================================================

interface CreateAuthCodeParams {
  clientId: string;
  userId: string;
  redirectUri: string;
  scopes: string[];
  codeChallenge: string;
  resource?: string;
  state?: string;
}

/**
 * Creates a new authorization code.
 * Returns the raw code (to be sent to client).
 */
export async function createAuthorizationCode(params: CreateAuthCodeParams): Promise<string> {
  const code = generateAuthorizationCode();
  const codeHash = hashToken(code);

  await db.insert(oauthAuthorizationCodes).values({
    id: generateUuidv7(),
    codeHash,
    clientId: params.clientId,
    userId: params.userId,
    redirectUri: params.redirectUri,
    scopes: params.scopes,
    codeChallenge: params.codeChallenge,
    codeChallengeMethod: "S256",
    resource: params.resource,
    state: params.state,
    expiresAt: getAuthCodeExpiry(),
  });

  return code;
}

interface AuthCodeValidation {
  userId: string;
  scopes: string[];
  resource: string | null;
}

/**
 * Validates and consumes an authorization code.
 * Returns the code data if valid, null otherwise.
 *
 * Consumption is a single atomic UPDATE ... WHERE used_at IS NULL, so of two
 * concurrent token requests presenting the same code exactly one succeeds
 * (OAuth 2.1 single-use requirement). The code is claimed before PKCE
 * verification, so a failed PKCE attempt also burns the code — that's the
 * safe direction (an attacker who stole a code can't retry verifiers).
 */
export async function validateAndConsumeAuthCode(
  code: string,
  clientId: string,
  redirectUri: string,
  codeVerifier: string
): Promise<AuthCodeValidation | null> {
  const codeHash = hashToken(code);

  // Atomically claim the code
  const result = await db
    .update(oauthAuthorizationCodes)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(oauthAuthorizationCodes.codeHash, codeHash),
        eq(oauthAuthorizationCodes.clientId, clientId),
        eq(oauthAuthorizationCodes.redirectUri, redirectUri),
        isNull(oauthAuthorizationCodes.usedAt),
        gt(oauthAuthorizationCodes.expiresAt, new Date())
      )
    )
    .returning();

  if (result.length === 0) {
    // The atomic claim matched nothing: the code is unknown, already used,
    // expired, or the client_id / redirect_uri don't match what was stored.
    logger.warn("OAuth code exchange rejected: code claim failed", {
      clientId,
      redirectUri,
    });
    return null;
  }

  const authCode = result[0];

  // Validate PKCE
  if (!validatePkceS256(codeVerifier, authCode.codeChallenge)) {
    logger.warn("OAuth code exchange rejected: PKCE verification failed", { clientId });
    return null;
  }

  return {
    userId: authCode.userId,
    scopes: authCode.scopes,
    resource: authCode.resource,
  };
}

// ============================================================================
// Token Management
// ============================================================================

interface CreateTokensParams {
  clientId: string;
  userId: string;
  scopes: string[];
  resource?: string | null;
}

/**
 * Creates a new access token and refresh token pair.
 */
export async function createTokens(params: CreateTokensParams): Promise<TokenPair> {
  const accessToken = generateToken();
  const refreshToken = generateToken();
  const accessTokenHash = hashToken(accessToken);
  const refreshTokenHash = hashToken(refreshToken);

  const accessTokenId = generateUuidv7();
  const refreshTokenId = generateUuidv7();

  const accessTokenExpiry = getAccessTokenExpiry();
  const refreshTokenExpiry = getRefreshTokenExpiry();

  // Insert access token
  await db.insert(oauthAccessTokens).values({
    id: accessTokenId,
    tokenHash: accessTokenHash,
    clientId: params.clientId,
    userId: params.userId,
    scopes: params.scopes,
    resource: params.resource ?? null,
    expiresAt: accessTokenExpiry,
  });

  // Insert refresh token
  await db.insert(oauthRefreshTokens).values({
    id: refreshTokenId,
    tokenHash: refreshTokenHash,
    clientId: params.clientId,
    userId: params.userId,
    scopes: params.scopes,
    resource: params.resource ?? null,
    accessTokenId,
    expiresAt: refreshTokenExpiry,
  });

  return {
    accessToken,
    refreshToken,
    tokenType: "Bearer",
    expiresIn: Math.floor((accessTokenExpiry.getTime() - Date.now()) / 1000),
    scope: params.scopes.join(" "),
  };
}

/**
 * Validates an access token and returns the token data.
 */
export async function validateAccessToken(token: string): Promise<OAuthTokenData | null> {
  const tokenHash = hashToken(token);

  const result = await db
    .select({
      token: oauthAccessTokens,
      user: users,
    })
    .from(oauthAccessTokens)
    .innerJoin(users, eq(oauthAccessTokens.userId, users.id))
    .where(
      and(
        eq(oauthAccessTokens.tokenHash, tokenHash),
        isNull(oauthAccessTokens.revokedAt),
        gt(oauthAccessTokens.expiresAt, new Date())
      )
    )
    .limit(1);

  if (result.length === 0) {
    return null;
  }

  const { token: accessToken, user } = result[0];

  // Update last_used_at asynchronously
  void updateAccessTokenLastUsed(accessToken.id);

  return {
    userId: accessToken.userId,
    clientId: accessToken.clientId,
    scopes: accessToken.scopes,
    resource: accessToken.resource,
    user,
  };
}

/**
 * Updates the last_used_at timestamp for an access token.
 */
async function updateAccessTokenLastUsed(tokenId: string): Promise<void> {
  try {
    await db
      .update(oauthAccessTokens)
      .set({ lastUsedAt: new Date() })
      .where(eq(oauthAccessTokens.id, tokenId));
  } catch (err) {
    console.error("Failed to update OAuth access token last_used_at:", err);
  }
}

/**
 * Validates a refresh token and rotates it (creates new tokens, revokes old).
 *
 * The presented token is claimed with an atomic UPDATE ... WHERE revoked_at IS
 * NULL, so concurrent requests with the same token can't both rotate it.
 * Presenting an already-rotated (revoked but unexpired) token is treated as
 * rotation reuse — evidence the token leaked — and revokes every active token
 * for that user+client pair, per OAuth 2.1 refresh token rotation guidance.
 */
export async function rotateRefreshToken(
  refreshToken: string,
  clientId: string
): Promise<TokenPair | null> {
  const tokenHash = hashToken(refreshToken);
  const now = new Date();

  // Atomically claim (revoke) the presented refresh token
  const claimed = await db
    .update(oauthRefreshTokens)
    .set({ revokedAt: now })
    .where(
      and(
        eq(oauthRefreshTokens.tokenHash, tokenHash),
        eq(oauthRefreshTokens.clientId, clientId),
        isNull(oauthRefreshTokens.revokedAt),
        gt(oauthRefreshTokens.expiresAt, now)
      )
    )
    .returning();

  if (claimed.length === 0) {
    await handlePossibleRefreshTokenReuse(tokenHash, clientId, now);
    return null;
  }

  const oldRefreshToken = claimed[0];

  // Revoke the old access token if it exists
  if (oldRefreshToken.accessTokenId) {
    await db
      .update(oauthAccessTokens)
      .set({ revokedAt: now })
      .where(eq(oauthAccessTokens.id, oldRefreshToken.accessTokenId));
  }

  // Preserve the token's own audience across rotation, migrating only the
  // legacy bare-origin MCP audience to the canonical /api/mcp identifier. That
  // migration lets the legacy origin alias age out instead of self-perpetuating
  // (see getAcceptedResourceIdentifiers), but it must not blanket-stamp every
  // rotated token with the MCP audience: the Wallabag compat API shares this
  // rotation path and mints tokens with a null resource, so forcing the MCP
  // identifier would mislabel a Wallabag credential as MCP-audienced. Anything
  // that isn't the legacy origin (the canonical MCP identifier, or a null
  // Wallabag audience) is carried forward unchanged.
  const existingResource = oldRefreshToken.resource;
  const reboundResource =
    existingResource !== null && isResourceForThisServer(existingResource, getIssuer())
      ? getResourceIdentifier()
      : existingResource;
  const newTokens = await createTokens({
    clientId: oldRefreshToken.clientId,
    userId: oldRefreshToken.userId,
    scopes: oldRefreshToken.scopes,
    resource: reboundResource,
  });

  // Link the rotation chain on the old token
  const newRefreshTokenHash = hashToken(newTokens.refreshToken);
  const newRefreshTokenResult = await db
    .select({ id: oauthRefreshTokens.id })
    .from(oauthRefreshTokens)
    .where(eq(oauthRefreshTokens.tokenHash, newRefreshTokenHash))
    .limit(1);

  const newRefreshTokenId = newRefreshTokenResult[0]?.id;
  if (newRefreshTokenId) {
    await db
      .update(oauthRefreshTokens)
      .set({ replacedById: newRefreshTokenId })
      .where(eq(oauthRefreshTokens.id, oldRefreshToken.id));
  }

  return newTokens;
}

/**
 * Rotation-reuse detection: if a rotation attempt failed because the token was
 * already revoked (but is otherwise valid and unexpired), someone is replaying
 * an old refresh token. Revoke all active tokens for that user+client so the
 * leaked chain is dead no matter which copy the attacker holds.
 */
async function handlePossibleRefreshTokenReuse(
  tokenHash: string,
  clientId: string,
  now: Date
): Promise<void> {
  const [presented] = await db
    .select()
    .from(oauthRefreshTokens)
    .where(
      and(eq(oauthRefreshTokens.tokenHash, tokenHash), eq(oauthRefreshTokens.clientId, clientId))
    )
    .limit(1);

  if (!presented || !presented.revokedAt || presented.expiresAt <= now) {
    // Unknown or merely expired token — not reuse, nothing to do
    return;
  }

  console.warn(
    `OAuth refresh token reuse detected for user ${presented.userId}, client ${clientId}; revoking all tokens for the grant`
  );

  await db
    .update(oauthRefreshTokens)
    .set({ revokedAt: now })
    .where(
      and(
        eq(oauthRefreshTokens.userId, presented.userId),
        eq(oauthRefreshTokens.clientId, clientId),
        isNull(oauthRefreshTokens.revokedAt)
      )
    );

  await db
    .update(oauthAccessTokens)
    .set({ revokedAt: now })
    .where(
      and(
        eq(oauthAccessTokens.userId, presented.userId),
        eq(oauthAccessTokens.clientId, clientId),
        isNull(oauthAccessTokens.revokedAt)
      )
    );
}

/**
 * Revokes a token presented by a client (RFC 7009).
 *
 * The token may be an access token or a refresh token; both tables are checked
 * regardless of any `token_type_hint` (the RFC allows extending the search).
 * Revoking a refresh token also revokes the access token issued with it
 * (RFC 7009 §2.1: the server SHOULD invalidate related tokens).
 *
 * Only tokens belonging to `clientId` are revoked — a token owned by another
 * client is treated like an unknown token (a silent no-op), which is also what
 * the caller reports: RFC 7009 requires HTTP 200 for unknown tokens.
 */
export async function revokeClientToken(clientId: string, token: string): Promise<void> {
  const tokenHash = hashToken(token);
  const now = new Date();

  await db
    .update(oauthAccessTokens)
    .set({ revokedAt: now })
    .where(
      and(
        eq(oauthAccessTokens.tokenHash, tokenHash),
        eq(oauthAccessTokens.clientId, clientId),
        isNull(oauthAccessTokens.revokedAt)
      )
    );

  const [refreshToken] = await db
    .select({
      id: oauthRefreshTokens.id,
      accessTokenId: oauthRefreshTokens.accessTokenId,
      revokedAt: oauthRefreshTokens.revokedAt,
    })
    .from(oauthRefreshTokens)
    .where(
      and(eq(oauthRefreshTokens.tokenHash, tokenHash), eq(oauthRefreshTokens.clientId, clientId))
    )
    .limit(1);

  if (!refreshToken || refreshToken.revokedAt) {
    return;
  }

  await db
    .update(oauthRefreshTokens)
    .set({ revokedAt: now })
    .where(eq(oauthRefreshTokens.id, refreshToken.id));

  if (refreshToken.accessTokenId) {
    await db
      .update(oauthAccessTokens)
      .set({ revokedAt: now })
      .where(
        and(
          eq(oauthAccessTokens.id, refreshToken.accessTokenId),
          isNull(oauthAccessTokens.revokedAt)
        )
      );
  }
}

// ============================================================================
// Consent Management
// ============================================================================

/**
 * Checks if user has already consented to the client with required scopes.
 */
export async function hasConsent(
  userId: string,
  clientId: string,
  scopes: string[]
): Promise<boolean> {
  const result = await db
    .select()
    .from(oauthConsentGrants)
    .where(
      and(
        eq(oauthConsentGrants.userId, userId),
        eq(oauthConsentGrants.clientId, clientId),
        isNull(oauthConsentGrants.revokedAt)
      )
    )
    .limit(1);

  if (result.length === 0) {
    return false;
  }

  // Check if all requested scopes are in the granted scopes
  const grantedScopes = result[0].scopes;
  return scopes.every((scope) => grantedScopes.includes(scope));
}

/**
 * Records user consent for a client.
 */
export async function recordConsent(
  userId: string,
  clientId: string,
  scopes: string[]
): Promise<void> {
  await db
    .insert(oauthConsentGrants)
    .values({
      id: generateUuidv7(),
      userId,
      clientId,
      scopes,
    })
    .onConflictDoUpdate({
      target: [oauthConsentGrants.userId, oauthConsentGrants.clientId],
      set: {
        scopes,
        updatedAt: new Date(),
        revokedAt: null, // Clear any previous revocation
      },
    });
}

// ============================================================================
// Dynamic Client Registration (RFC 7591)
// ============================================================================

/**
 * Client registration request as defined in RFC 7591
 */
export interface ClientRegistrationRequest {
  redirect_uris: string[];
  token_endpoint_auth_method?: string;
  grant_types?: string[];
  response_types?: string[];
  client_name?: string;
  client_uri?: string;
  logo_uri?: string;
  scope?: string;
  contacts?: string[];
  tos_uri?: string;
  policy_uri?: string;
  jwks_uri?: string;
  jwks?: object;
  software_id?: string;
  software_version?: string;
  software_statement?: string;
}

/**
 * Client registration response as defined in RFC 7591
 */
export interface ClientRegistrationResponse {
  client_id: string;
  client_secret?: string;
  client_id_issued_at?: number;
  client_secret_expires_at?: number;
  client_secret_issued_at?: number;
  registration_client_uri?: string;
  redirect_uris: string[];
  token_endpoint_auth_method: string;
  grant_types: string[];
  response_types: string[];
  client_name?: string;
  client_uri?: string;
  logo_uri?: string;
  scope?: string;
  contacts?: string[];
  tos_uri?: string;
  policy_uri?: string;
  jwks_uri?: string;
  jwks?: object;
  software_id?: string;
  software_version?: string;
}

/**
 * Error returned from client registration
 */
export interface ClientRegistrationError {
  error: string;
  error_description?: string;
}

/**
 * Generates a unique client ID for dynamic registration.
 */
function generateClientId(): string {
  // Use UUIDv7 for time-ordered client IDs
  return generateUuidv7();
}

/**
 * Registers a new OAuth client dynamically (RFC 7591).
 * Supports open registration (no initial access token required).
 *
 * @param request - Client registration request
 * @param host - Request Host header; picks the OAuth surface (apex vs MCP host)
 *   the `registration_client_uri` is expressed on
 * @returns Client registration response or error
 */
export async function registerClient(
  request: ClientRegistrationRequest,
  host?: string | null
): Promise<
  | { success: true; data: ClientRegistrationResponse }
  | { success: false; error: ClientRegistrationError }
> {
  // Validate required fields
  if (
    !request.redirect_uris ||
    !Array.isArray(request.redirect_uris) ||
    request.redirect_uris.length === 0
  ) {
    return {
      success: false,
      error: {
        error: "invalid_redirect_uri",
        error_description: "redirect_uris is required and must be a non-empty array",
      },
    };
  }

  // Validate all redirect URIs
  for (const uri of request.redirect_uris) {
    if (!isValidRedirectUriFormat(uri)) {
      return {
        success: false,
        error: {
          error: "invalid_redirect_uri",
          error_description: `Invalid redirect URI: ${uri}. Must be HTTPS (or HTTP for localhost) and must not contain fragments.`,
        },
      };
    }
  }

  // Validate token_endpoint_auth_method. When omitted, RFC 7591 §2 defines the
  // default as client_secret_basic (a confidential client) — the working remote
  // MCP servers (Linear, Sentry, Notion) all follow this, so clients that omit
  // the field demonstrably handle receiving a secret.
  const authMethod = request.token_endpoint_auth_method ?? "client_secret_basic";
  if (!SUPPORTED_TOKEN_ENDPOINT_AUTH_METHODS.includes(authMethod)) {
    return {
      success: false,
      error: {
        error: "invalid_client_metadata",
        error_description: `Unsupported token_endpoint_auth_method: ${authMethod}. Supported methods: ${SUPPORTED_TOKEN_ENDPOINT_AUTH_METHODS.join(", ")}`,
      },
    };
  }

  // Determine if client is public or confidential
  const isPublic = authMethod === "none";

  // Generate client secret for confidential clients
  let clientSecret: string | undefined;
  let clientSecretHash: string | null = null;
  if (!isPublic) {
    clientSecret = generateToken();
    clientSecretHash = hashToken(clientSecret);
  }

  // Validate and normalize grant_types
  const requestedGrantTypes = request.grant_types ?? ["authorization_code"];
  const supportedGrantTypes = ["authorization_code", "refresh_token"];
  const grantTypes = requestedGrantTypes.filter((gt) => supportedGrantTypes.includes(gt));
  if (grantTypes.length === 0) {
    return {
      success: false,
      error: {
        error: "invalid_client_metadata",
        error_description: `No supported grant types. Supported: ${supportedGrantTypes.join(", ")}`,
      },
    };
  }

  // Validate response_types match grant_types (per RFC 7591 Section 2.1)
  const requestedResponseTypes = request.response_types ?? ["code"];
  const responseTypes: string[] = [];
  if (grantTypes.includes("authorization_code") && requestedResponseTypes.includes("code")) {
    responseTypes.push("code");
  }
  // Note: We don't support "implicit" grant type, so "token" response type is not allowed
  if (responseTypes.length === 0 && grantTypes.includes("authorization_code")) {
    responseTypes.push("code");
  }

  // Validate scope. A client that requests scopes gets exactly the supported
  // subset of those scopes. If none of the requested scopes are recognized we
  // reject the registration rather than silently broadening to "all scopes"
  // (defaulting unknown scopes to null/all is a privilege-escalation footgun).
  // When no scope is requested, scopes stays null (client may later request any
  // supported scope at authorization time, subject to user consent).
  const supportedScopes = Object.values(OAUTH_SCOPES);
  let scopes: string[] | null = null;
  if (request.scope) {
    const requestedScopes = request.scope.split(" ");
    const validScopes = Array.from(
      new Set(
        requestedScopes.filter((s) =>
          supportedScopes.includes(s as (typeof supportedScopes)[number])
        )
      )
    );
    if (validScopes.length === 0) {
      return {
        success: false,
        error: {
          error: "invalid_client_metadata",
          error_description: `None of the requested scopes are supported. Supported scopes: ${supportedScopes.join(", ")}`,
        },
      };
    }
    scopes = validScopes;
  }

  // Generate client ID
  const clientId = generateClientId();
  const clientName = request.client_name ?? "Unknown Application";

  // Store client in database
  const now = new Date();
  await db.insert(oauthClients).values({
    id: generateUuidv7(),
    clientId,
    name: clientName,
    redirectUris: request.redirect_uris,
    grantTypes,
    scopes,
    isPublic,
    clientSecretHash,
    createdAt: now,
    updatedAt: now,
  });

  // Build response
  const response: ClientRegistrationResponse = {
    client_id: clientId,
    client_id_issued_at: Math.floor(now.getTime() / 1000),
    redirect_uris: request.redirect_uris,
    token_endpoint_auth_method: authMethod,
    grant_types: grantTypes,
    response_types: responseTypes,
    // Response-shape parity with the working remote MCP servers (Linear, Sentry,
    // Notion), which all include this field. RFC 7592 client management is not
    // implemented (theirs isn't either — Linear's URI 404s), and per RFC 7592 a
    // client can't use it anyway without a registration_access_token, which we
    // don't issue. Host-derived so a registration on the MCP host doesn't
    // reference the apex origin.
    registration_client_uri: getRegistrationClientUri(clientId, host),
  };

  // Add client_secret for confidential clients
  if (clientSecret) {
    response.client_secret = clientSecret;
    response.client_secret_expires_at = 0; // 0 means it doesn't expire
    // Not an RFC 7591 field, but BOTH Notion and Linear include it in
    // confidential-client registrations and they are the reference targets the
    // claude.ai connector demonstrably works against — a strict client response
    // model built against them could require it whenever client_secret is
    // present. Cheap parity; observed during the #986 subdomain debugging.
    response.client_secret_issued_at = Math.floor(now.getTime() / 1000);
  }

  // Add optional fields if provided
  if (request.client_name) {
    response.client_name = request.client_name;
  }
  if (request.client_uri) {
    response.client_uri = request.client_uri;
  }
  if (request.logo_uri) {
    response.logo_uri = request.logo_uri;
  }
  if (scopes) {
    response.scope = scopes.join(" ");
  }
  if (request.contacts) {
    response.contacts = request.contacts;
  }
  if (request.tos_uri) {
    response.tos_uri = request.tos_uri;
  }
  if (request.policy_uri) {
    response.policy_uri = request.policy_uri;
  }
  if (request.software_id) {
    response.software_id = request.software_id;
  }
  if (request.software_version) {
    response.software_version = request.software_version;
  }

  return { success: true, data: response };
}

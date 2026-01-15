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
  type OAuthClient,
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
} from "./utils";
import { USER_AGENT } from "@/server/http/user-agent";

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
 * Fetches Client ID Metadata Document from URL.
 */
async function fetchClientMetadata(url: string): Promise<ClientMetadata | null> {
  try {
    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": USER_AGENT,
      },
    });

    if (!response.ok) {
      return null;
    }

    const metadata = (await response.json()) as ClientMetadata;

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
 */
export async function validateAndConsumeAuthCode(
  code: string,
  clientId: string,
  redirectUri: string,
  codeVerifier: string
): Promise<AuthCodeValidation | null> {
  const codeHash = hashToken(code);

  // Get the code from database
  const result = await db
    .select()
    .from(oauthAuthorizationCodes)
    .where(
      and(
        eq(oauthAuthorizationCodes.codeHash, codeHash),
        eq(oauthAuthorizationCodes.clientId, clientId),
        eq(oauthAuthorizationCodes.redirectUri, redirectUri),
        isNull(oauthAuthorizationCodes.usedAt),
        gt(oauthAuthorizationCodes.expiresAt, new Date())
      )
    )
    .limit(1);

  if (result.length === 0) {
    return null;
  }

  const authCode = result[0];

  // Validate PKCE
  if (!validatePkceS256(codeVerifier, authCode.codeChallenge)) {
    return null;
  }

  // Mark code as used
  await db
    .update(oauthAuthorizationCodes)
    .set({ usedAt: new Date() })
    .where(eq(oauthAuthorizationCodes.id, authCode.id));

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
 */
export async function rotateRefreshToken(
  refreshToken: string,
  clientId: string
): Promise<TokenPair | null> {
  const tokenHash = hashToken(refreshToken);

  // Get the refresh token
  const result = await db
    .select()
    .from(oauthRefreshTokens)
    .where(
      and(
        eq(oauthRefreshTokens.tokenHash, tokenHash),
        eq(oauthRefreshTokens.clientId, clientId),
        isNull(oauthRefreshTokens.revokedAt),
        gt(oauthRefreshTokens.expiresAt, new Date())
      )
    )
    .limit(1);

  if (result.length === 0) {
    return null;
  }

  const oldRefreshToken = result[0];

  // Create new tokens
  const newTokens = await createTokens({
    clientId: oldRefreshToken.clientId,
    userId: oldRefreshToken.userId,
    scopes: oldRefreshToken.scopes,
  });

  // Get the new refresh token ID to link rotation chain
  const newRefreshTokenHash = hashToken(newTokens.refreshToken);
  const newRefreshTokenResult = await db
    .select({ id: oauthRefreshTokens.id })
    .from(oauthRefreshTokens)
    .where(eq(oauthRefreshTokens.tokenHash, newRefreshTokenHash))
    .limit(1);

  const newRefreshTokenId = newRefreshTokenResult[0]?.id;

  // Revoke old refresh token and link to new one
  await db
    .update(oauthRefreshTokens)
    .set({
      revokedAt: new Date(),
      replacedById: newRefreshTokenId,
    })
    .where(eq(oauthRefreshTokens.id, oldRefreshToken.id));

  // Also revoke the old access token if it exists
  if (oldRefreshToken.accessTokenId) {
    await db
      .update(oauthAccessTokens)
      .set({ revokedAt: new Date() })
      .where(eq(oauthAccessTokens.id, oldRefreshToken.accessTokenId));
  }

  return newTokens;
}

/**
 * Revokes all tokens for a user-client pair.
 */
export async function revokeClientTokens(userId: string, clientId: string): Promise<void> {
  const now = new Date();

  await Promise.all([
    db
      .update(oauthAccessTokens)
      .set({ revokedAt: now })
      .where(
        and(
          eq(oauthAccessTokens.userId, userId),
          eq(oauthAccessTokens.clientId, clientId),
          isNull(oauthAccessTokens.revokedAt)
        )
      ),
    db
      .update(oauthRefreshTokens)
      .set({ revokedAt: now })
      .where(
        and(
          eq(oauthRefreshTokens.userId, userId),
          eq(oauthRefreshTokens.clientId, clientId),
          isNull(oauthRefreshTokens.revokedAt)
        )
      ),
  ]);
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

/**
 * Revokes user consent for a client.
 */
export async function revokeConsent(userId: string, clientId: string): Promise<void> {
  await Promise.all([
    db
      .update(oauthConsentGrants)
      .set({ revokedAt: new Date() })
      .where(and(eq(oauthConsentGrants.userId, userId), eq(oauthConsentGrants.clientId, clientId))),
    revokeClientTokens(userId, clientId),
  ]);
}

/**
 * Gets all active consent grants for a user.
 */
export async function getUserConsents(userId: string) {
  return db
    .select()
    .from(oauthConsentGrants)
    .where(and(eq(oauthConsentGrants.userId, userId), isNull(oauthConsentGrants.revokedAt)));
}

// ============================================================================
// Client Management
// ============================================================================

/**
 * Creates or updates an OAuth client (for pre-registration).
 */
export async function upsertClient(client: {
  clientId: string;
  name: string;
  redirectUris: string[];
  grantTypes?: string[];
  scopes?: string[];
  isPublic?: boolean;
  clientSecret?: string;
}): Promise<OAuthClient> {
  const clientSecretHash = client.clientSecret ? hashToken(client.clientSecret) : null;

  const result = await db
    .insert(oauthClients)
    .values({
      id: generateUuidv7(),
      clientId: client.clientId,
      name: client.name,
      redirectUris: client.redirectUris,
      grantTypes: client.grantTypes ?? ["authorization_code", "refresh_token"],
      scopes: client.scopes,
      isPublic: client.isPublic ?? true,
      clientSecretHash,
    })
    .onConflictDoUpdate({
      target: [oauthClients.clientId],
      set: {
        name: client.name,
        redirectUris: client.redirectUris,
        grantTypes: client.grantTypes ?? ["authorization_code", "refresh_token"],
        scopes: client.scopes,
        isPublic: client.isPublic ?? true,
        clientSecretHash,
        updatedAt: new Date(),
      },
    })
    .returning();

  return result[0];
}

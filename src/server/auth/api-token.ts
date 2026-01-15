/**
 * API Token Management
 *
 * Handles API token generation, validation, and scope checking.
 * API tokens are used by browser extensions and third-party integrations.
 *
 * Token format: 32 random bytes, base64url encoded (same as sessions)
 * Storage: SHA-256 hash in database (never store raw tokens)
 */

import crypto from "crypto";
import { eq, and, isNull, or, gt } from "drizzle-orm";
import { db } from "@/server/db";
import { apiTokens, users, type User, type ApiToken } from "@/server/db/schema";
import { generateUuidv7 } from "@/lib/uuidv7";

// ============================================================================
// Constants
// ============================================================================

/**
 * Available API token scopes.
 * Each scope grants access to specific operations.
 */
export const API_TOKEN_SCOPES = {
  /** Allows saving articles (POST /api/v1/saved) */
  SAVED_WRITE: "saved:write",
  /** Allows full MCP (Model Context Protocol) access */
  MCP: "mcp",
} as const;

export type ApiTokenScope = (typeof API_TOKEN_SCOPES)[keyof typeof API_TOKEN_SCOPES];

// ============================================================================
// Types
// ============================================================================

/**
 * API token data returned from validation
 */
export interface ApiTokenData {
  token: ApiToken;
  user: User;
}

// ============================================================================
// Token Generation
// ============================================================================

/**
 * Generates a secure API token.
 * Returns both the raw token (for client) and its hash (for storage).
 */
function generateApiToken(): { token: string; tokenHash: string } {
  // Generate 32 random bytes, encode as base64url
  const token = crypto.randomBytes(32).toString("base64url");

  // Hash the token for storage (we never store raw tokens)
  const tokenHash = hashApiToken(token);

  return { token, tokenHash };
}

/**
 * Hashes an API token using SHA-256.
 * Used for both storage and lookup.
 */
function hashApiToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

// ============================================================================
// Token Creation
// ============================================================================

/**
 * Creates a new API token for a user.
 *
 * @param userId - The user ID to create the token for
 * @param scopes - The scopes to grant to this token
 * @param name - Optional name for the token (e.g., "Browser Extension")
 * @param expiresAt - Optional expiration date
 * @returns The raw token (for client) - this is the only time it's available
 */
export async function createApiToken(
  userId: string,
  scopes: ApiTokenScope[],
  name?: string,
  expiresAt?: Date
): Promise<string> {
  const { token, tokenHash } = generateApiToken();

  await db.insert(apiTokens).values({
    id: generateUuidv7(),
    userId,
    tokenHash,
    scopes,
    name,
    expiresAt,
  });

  return token;
}

// ============================================================================
// Token Validation
// ============================================================================

/**
 * Validates an API token and returns the token with user data.
 * Returns null if the token is invalid, expired, or revoked.
 */
export async function validateApiToken(token: string): Promise<ApiTokenData | null> {
  const tokenHash = hashApiToken(token);

  const result = await db
    .select({
      token: apiTokens,
      user: users,
    })
    .from(apiTokens)
    .innerJoin(users, eq(apiTokens.userId, users.id))
    .where(
      and(
        eq(apiTokens.tokenHash, tokenHash),
        isNull(apiTokens.revokedAt),
        // Not expired (null means no expiry)
        or(isNull(apiTokens.expiresAt), gt(apiTokens.expiresAt, new Date()))
      )
    )
    .limit(1);

  if (result.length === 0) {
    return null;
  }

  const tokenData = result[0];

  // Update last_used_at asynchronously (fire and forget)
  void updateLastUsedAt(tokenData.token.id);

  return tokenData;
}

/**
 * Updates the last_used_at timestamp for a token.
 * This is done asynchronously to not block the request.
 */
async function updateLastUsedAt(tokenId: string): Promise<void> {
  try {
    await db.update(apiTokens).set({ lastUsedAt: new Date() }).where(eq(apiTokens.id, tokenId));
  } catch (err) {
    console.error("Failed to update API token last_used_at:", err);
  }
}

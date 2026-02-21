/**
 * Session Management
 *
 * Handles session token generation, validation, and caching.
 * Sessions are stored in Postgres with a Redis cache for fast lookups.
 *
 * Token format: 32 random bytes, base64url encoded
 * Storage: SHA-256 hash in database (never store raw tokens)
 * Cache: Redis with 5 minute TTL
 */

import crypto from "crypto";
import { eq, and, isNull, gt } from "drizzle-orm";
import { db, type Database } from "@/server/db";
import { sessions, users, type User, type Session } from "@/server/db/schema";
import { generateUuidv7 } from "@/lib/uuidv7";
import { getRedisClient } from "@/server/redis";
import { decryptApiKey } from "@/lib/encryption";

// ============================================================================
// Constants
// ============================================================================

/**
 * Session duration in days
 */
const SESSION_DURATION_DAYS = 30;

/**
 * Redis cache TTL for sessions (5 minutes)
 */
const SESSION_CACHE_TTL_SECONDS = 300;

/**
 * Redis key prefix for session cache
 */
const SESSION_CACHE_PREFIX = "session:";

// ============================================================================
// Types
// ============================================================================

/**
 * Session data returned from validation
 */
export interface SessionData {
  session: Session;
  user: User;
}

/**
 * Cached session data structure stored in Redis
 */
interface CachedSession {
  sessionId: string;
  userId: string;
  userEmail: string;
  expiresAt: string;
  revokedAt: string | null;
  createdAt: string;
  lastActiveAt: string;
  userAgent: string | null;
  ipAddress: string | null;
  userCreatedAt: string;
  userUpdatedAt: string;
  userEmailVerifiedAt: string | null;
  userPasswordHash: string | null;
  userInviteId: string | null;
  userShowSpam: boolean;
  userAlgorithmicFeedEnabled: boolean;
  userGroqApiKey: string | null;
  userAnthropicApiKey: string | null;
  userSummarizationModel: string | null;
  userSummarizationMaxWords: number | null;
  userSummarizationPrompt: string | null;
}

// ============================================================================
// Token Generation
// ============================================================================

/**
 * Generates a secure session token.
 * Returns both the raw token (for client) and its hash (for storage).
 */
function generateSessionToken(): { token: string; tokenHash: string } {
  // Generate 32 random bytes, encode as base64url
  const token = crypto.randomBytes(32).toString("base64url");

  // Hash the token for storage (we never store raw tokens)
  const tokenHash = hashToken(token);

  return { token, tokenHash };
}

/**
 * Hashes a session token using SHA-256.
 * Used for both storage and lookup.
 */
function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/**
 * Calculates session expiry date
 */
function getSessionExpiry(): Date {
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + SESSION_DURATION_DAYS);
  return expiresAt;
}

// ============================================================================
// Session Creation
// ============================================================================

/**
 * Parameters for creating a new session
 */
export interface CreateSessionParams {
  /** User ID to create session for */
  userId: string;
  /** User-Agent header from request */
  userAgent?: string;
  /** IP address from request */
  ipAddress?: string;
}

/**
 * Result of creating a new session
 */
export interface CreateSessionResult {
  /** Session ID (UUIDv7) */
  sessionId: string;
  /** Raw session token to return to client (never stored) */
  token: string;
}

/**
 * Transaction type - accepts both db and transaction contexts
 */
type DbOrTx = Database | Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * Creates a new session for a user.
 *
 * This centralizes session creation logic that was previously duplicated
 * across 6 different places (register, login, OAuth callbacks).
 *
 * @param dbOrTx - Database or transaction context
 * @param params - Session creation parameters
 * @returns The session ID and raw token (token should be returned to client)
 */
export async function createSession(
  dbOrTx: DbOrTx,
  params: CreateSessionParams
): Promise<CreateSessionResult> {
  const { userId, userAgent, ipAddress } = params;

  const sessionId = generateUuidv7();
  const { token, tokenHash } = generateSessionToken();
  const expiresAt = getSessionExpiry();
  const now = new Date();

  await dbOrTx.insert(sessions).values({
    id: sessionId,
    userId,
    tokenHash,
    userAgent,
    ipAddress,
    expiresAt,
    createdAt: now,
    lastActiveAt: now,
  });

  return { sessionId, token };
}

// ============================================================================
// Session Validation
// ============================================================================

/**
 * Gets the Redis cache key for a token hash
 */
function getCacheKey(tokenHash: string): string {
  return `${SESSION_CACHE_PREFIX}${tokenHash}`;
}

/**
 * Serializes session data for Redis cache
 */
function serializeForCache(data: SessionData): string {
  const cached: CachedSession = {
    sessionId: data.session.id,
    userId: data.user.id,
    userEmail: data.user.email,
    expiresAt: data.session.expiresAt.toISOString(),
    revokedAt: data.session.revokedAt?.toISOString() ?? null,
    createdAt: data.session.createdAt.toISOString(),
    lastActiveAt: data.session.lastActiveAt.toISOString(),
    userAgent: data.session.userAgent,
    ipAddress: data.session.ipAddress,
    userCreatedAt: data.user.createdAt.toISOString(),
    userUpdatedAt: data.user.updatedAt.toISOString(),
    userEmailVerifiedAt: data.user.emailVerifiedAt?.toISOString() ?? null,
    userPasswordHash: data.user.passwordHash,
    userInviteId: data.user.inviteId ?? null,
    userShowSpam: data.user.showSpam,
    userAlgorithmicFeedEnabled: data.user.algorithmicFeedEnabled,
    userGroqApiKey: data.user.groqApiKey ?? null,
    userAnthropicApiKey: data.user.anthropicApiKey ?? null,
    userSummarizationModel: data.user.summarizationModel ?? null,
    userSummarizationMaxWords: data.user.summarizationMaxWords ?? null,
    userSummarizationPrompt: data.user.summarizationPrompt ?? null,
  };
  return JSON.stringify(cached);
}

/**
 * Deserializes session data from Redis cache
 */
function deserializeFromCache(data: string): SessionData {
  const cached = JSON.parse(data) as CachedSession;
  return {
    session: {
      id: cached.sessionId,
      userId: cached.userId,
      tokenHash: "", // Not needed after validation
      expiresAt: new Date(cached.expiresAt),
      revokedAt: cached.revokedAt ? new Date(cached.revokedAt) : null,
      createdAt: new Date(cached.createdAt),
      lastActiveAt: new Date(cached.lastActiveAt),
      userAgent: cached.userAgent,
      ipAddress: cached.ipAddress,
    },
    user: {
      id: cached.userId,
      email: cached.userEmail,
      createdAt: new Date(cached.userCreatedAt),
      updatedAt: new Date(cached.userUpdatedAt),
      emailVerifiedAt: cached.userEmailVerifiedAt ? new Date(cached.userEmailVerifiedAt) : null,
      passwordHash: cached.userPasswordHash,
      inviteId: cached.userInviteId ?? null,
      showSpam: cached.userShowSpam ?? false,
      algorithmicFeedEnabled: cached.userAlgorithmicFeedEnabled ?? true,
      groqApiKey: cached.userGroqApiKey ?? null,
      anthropicApiKey: cached.userAnthropicApiKey ?? null,
      summarizationModel: cached.userSummarizationModel ?? null,
      summarizationMaxWords: cached.userSummarizationMaxWords ?? null,
      summarizationPrompt: cached.userSummarizationPrompt ?? null,
    },
  };
}

/**
 * Validates a session token and returns the session with user data.
 * Uses Redis cache for fast lookups, falls back to database on cache miss.
 * Returns null if the token is invalid, expired, or revoked.
 */
export async function validateSession(token: string): Promise<SessionData | null> {
  const tokenHash = hashToken(token);
  const cacheKey = getCacheKey(tokenHash);
  const redis = getRedisClient();

  // Try Redis cache first (if available)
  if (redis) {
    try {
      const cached = await redis.get(cacheKey);
      if (cached) {
        const data = deserializeFromCache(cached);

        // Verify session is still valid (not expired, not revoked)
        if (data.session.expiresAt > new Date() && data.session.revokedAt === null) {
          // Update last_active_at asynchronously (fire and forget)
          void updateLastActiveAt(data.session.id);
          return data;
        }

        // Session expired or revoked - remove from cache
        await redis.del(cacheKey);
      }
    } catch (err) {
      // Redis error - fall through to database lookup
      console.error("Redis cache error:", err);
    }
  }

  // Cache miss, Redis unavailable, or error - query database
  const result = await db
    .select({
      session: sessions,
      user: users,
    })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(
      and(
        eq(sessions.tokenHash, tokenHash),
        isNull(sessions.revokedAt),
        gt(sessions.expiresAt, new Date())
      )
    )
    .limit(1);

  if (result.length === 0) {
    return null;
  }

  const sessionData = result[0];

  // Decrypt API keys loaded from the database
  if (sessionData.user.groqApiKey) {
    sessionData.user.groqApiKey = decryptApiKey(sessionData.user.groqApiKey);
  }
  if (sessionData.user.anthropicApiKey) {
    sessionData.user.anthropicApiKey = decryptApiKey(sessionData.user.anthropicApiKey);
  }

  // Cache the result in Redis (if available)
  if (redis) {
    try {
      await redis.setex(cacheKey, SESSION_CACHE_TTL_SECONDS, serializeForCache(sessionData));
    } catch (err) {
      // Redis error - continue without caching
      console.error("Failed to cache session:", err);
    }
  }

  // Update last_active_at asynchronously (fire and forget)
  void updateLastActiveAt(sessionData.session.id);

  return sessionData;
}

/**
 * Updates the last_active_at timestamp for a session.
 * This is done asynchronously to not block the request.
 */
async function updateLastActiveAt(sessionId: string): Promise<void> {
  try {
    await db.update(sessions).set({ lastActiveAt: new Date() }).where(eq(sessions.id, sessionId));
  } catch (err) {
    console.error("Failed to update session last_active_at:", err);
  }
}

// ============================================================================
// Session Revocation
// ============================================================================

/**
 * Revokes a session by its ID.
 * Also removes the session from Redis cache.
 *
 * @param sessionId - The session ID to revoke
 * @returns true if the session was revoked, false if not found
 */
export async function revokeSession(sessionId: string): Promise<boolean> {
  // Get the session to find its token hash for cache invalidation
  const sessionResult = await db
    .select({ tokenHash: sessions.tokenHash })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);

  if (sessionResult.length === 0) {
    return false;
  }

  const { tokenHash } = sessionResult[0];

  // Revoke in database
  await db.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.id, sessionId));

  // Invalidate Redis cache (if available)
  const redis = getRedisClient();
  if (redis) {
    try {
      await redis.del(getCacheKey(tokenHash));
    } catch (err) {
      console.error("Failed to invalidate session cache:", err);
    }
  }

  return true;
}

/**
 * Revokes a session by its token.
 * Also removes the session from Redis cache.
 *
 * @param token - The session token to revoke
 * @returns true if the session was revoked, false if not found
 */
export async function revokeSessionByToken(token: string): Promise<boolean> {
  const tokenHash = hashToken(token);
  const cacheKey = getCacheKey(tokenHash);

  // Revoke in database
  const result = await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.tokenHash, tokenHash), isNull(sessions.revokedAt)));

  // Invalidate Redis cache (if available)
  const redis = getRedisClient();
  if (redis) {
    try {
      await redis.del(cacheKey);
    } catch (err) {
      console.error("Failed to invalidate session cache:", err);
    }
  }

  // Drizzle returns affected row count
  return result.rowCount !== null && result.rowCount > 0;
}

/**
 * Invalidates all session caches for a user without revoking the sessions.
 * Useful when user preferences are updated and cached session data needs refresh.
 *
 * @param userId - The user ID whose session caches to invalidate
 */
export async function invalidateUserSessionCaches(userId: string): Promise<void> {
  const redis = getRedisClient();

  // If Redis is not available, nothing to invalidate
  if (!redis) {
    return;
  }

  // Get all active sessions for this user
  const activeSessions = await db
    .select({ tokenHash: sessions.tokenHash })
    .from(sessions)
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));

  if (activeSessions.length === 0) {
    return;
  }

  // Invalidate all cache entries
  try {
    const pipeline = redis.pipeline();
    for (const session of activeSessions) {
      pipeline.del(getCacheKey(session.tokenHash));
    }
    await pipeline.exec();
  } catch (err) {
    console.error("Failed to invalidate session caches:", err);
  }
}

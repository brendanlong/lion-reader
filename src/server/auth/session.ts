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
import { eq, and, isNull, ne, gt, sql } from "drizzle-orm";
import { db, type Database } from "@/server/db";
import { sessions, users, type User, type Session } from "@/server/db/schema";
import { generateUuidv7 } from "@/lib/uuidv7";
import { getRedisClient } from "@/server/redis";
import { decryptApiKey } from "@/lib/encryption";
import { OAUTH_SCOPES } from "@/server/oauth/utils";

/**
 * Scopes a session may be restricted to. A scoped session is a fail-closed
 * bearer credential (see {@link CreateSessionParams.scopes}); minting one with
 * an unrecognized scope would create a credential that silently matches nothing
 * everywhere, so we reject unknown scopes up front instead.
 */
const VALID_SESSION_SCOPES = new Set<string>(Object.values(OAUTH_SCOPES));

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
 * Redis key prefix for session cache.
 *
 * The version suffix (`v2`) namespaces the cached payload format. Bump it
 * whenever a change to {@link CachedSession} is security-relevant — e.g. adding
 * the `scopes` field — so old-format entries written by a previous release are
 * never read by new code during a rolling deploy. A missing field would
 * otherwise deserialize to a default (`scopes` → `null` → full access), which
 * for a scoped session would be a fail-open. Old-format entries under the
 * previous prefix are simply left to expire via TTL.
 */
const SESSION_CACHE_PREFIX = "session:v2:";

// ============================================================================
// Types
// ============================================================================

/**
 * Session data returned from validation
 */
export interface SessionData {
  session: Session;
  // greaderUserId is a bigint (uncacheable in the Redis session JSON, and with no
  // nullable placeholder) that only the Google Reader user-info route needs — and
  // it reads that straight from the DB — so it's omitted from the session user.
  user: Omit<User, "greaderUserId">;
  /** Whether user has a Groq API key configured (actual key not cached for security) */
  hasGroqApiKey: boolean;
  /** Whether user has an Anthropic API key configured (actual key not cached for security) */
  hasAnthropicApiKey: boolean;
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
  scopes: string[] | null;
  userAgent: string | null;
  ipAddress: string | null;
  userCreatedAt: string;
  userUpdatedAt: string;
  userEmailVerifiedAt: string | null;
  userInviteId: string | null;
  userShowSpam: boolean;
  userHasGroqApiKey: boolean;
  userHasAnthropicApiKey: boolean;
  userSummarizationModel: string | null;
  userSummarizationMaxWords: number | null;
  userSummarizationPrompt: string | null;
  userTosAgreedAt: string | null;
  userPrivacyPolicyAgreedAt: string | null;
  userNotEuAgreedAt: string | null;
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
  /**
   * Scopes to restrict this session to. Omit (undefined) for a normal
   * full-access browser session. Pass an array to mint a restricted session
   * (e.g. the Google Reader API passes ['reader:full-access']); such sessions
   * are only usable by callers that opt into scoped sessions.
   */
  scopes?: string[];
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
  const { userId, userAgent, ipAddress, scopes } = params;

  if (scopes) {
    const unknown = scopes.filter((scope) => !VALID_SESSION_SCOPES.has(scope));
    if (unknown.length > 0) {
      throw new Error(`Cannot create session with unknown scope(s): ${unknown.join(", ")}`);
    }
  }

  const sessionId = generateUuidv7();
  const { token, tokenHash } = generateSessionToken();
  const expiresAt = getSessionExpiry();
  const now = new Date();

  await dbOrTx.insert(sessions).values({
    id: sessionId,
    userId,
    tokenHash,
    scopes: scopes ?? null,
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
    scopes: data.session.scopes,
    userAgent: data.session.userAgent,
    ipAddress: data.session.ipAddress,
    userCreatedAt: data.user.createdAt.toISOString(),
    userUpdatedAt: data.user.updatedAt.toISOString(),
    userEmailVerifiedAt: data.user.emailVerifiedAt?.toISOString() ?? null,
    userInviteId: data.user.inviteId ?? null,
    userShowSpam: data.user.showSpam,
    userHasGroqApiKey: data.hasGroqApiKey,
    userHasAnthropicApiKey: data.hasAnthropicApiKey,
    userSummarizationModel: data.user.summarizationModel ?? null,
    userSummarizationMaxWords: data.user.summarizationMaxWords ?? null,
    userSummarizationPrompt: data.user.summarizationPrompt ?? null,
    userTosAgreedAt: data.user.tosAgreedAt?.toISOString() ?? null,
    userPrivacyPolicyAgreedAt: data.user.privacyPolicyAgreedAt?.toISOString() ?? null,
    userNotEuAgreedAt: data.user.notEuAgreedAt?.toISOString() ?? null,
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
      scopes: cached.scopes ?? null,
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
      passwordHash: null, // Not cached in Redis for security; query DB when needed
      inviteId: cached.userInviteId ?? null,
      showSpam: cached.userShowSpam ?? false,
      groqApiKey: null, // Not cached in Redis for security; use getUserApiKeys() when needed
      anthropicApiKey: null, // Not cached in Redis for security; use getUserApiKeys() when needed
      summarizationModel: cached.userSummarizationModel ?? null,
      summarizationMaxWords: cached.userSummarizationMaxWords ?? null,
      summarizationPrompt: cached.userSummarizationPrompt ?? null,
      tosAgreedAt: cached.userTosAgreedAt ? new Date(cached.userTosAgreedAt) : null,
      privacyPolicyAgreedAt: cached.userPrivacyPolicyAgreedAt
        ? new Date(cached.userPrivacyPolicyAgreedAt)
        : null,
      notEuAgreedAt: cached.userNotEuAgreedAt ? new Date(cached.userNotEuAgreedAt) : null,
      // Not cached in Redis; only the admin activity view reads it, from the DB.
      lastActiveAt: null,
      // Not cached in Redis; the badge queries read these from the DB directly,
      // never through the session user.
      savedUnreadCount: 0,
      starredUnreadCount: 0,
    },
    hasGroqApiKey: cached.userHasGroqApiKey ?? false,
    hasAnthropicApiKey: cached.userHasAnthropicApiKey ?? false,
  };
}

/**
 * Options for {@link validateSession}.
 */
export interface ValidateSessionOptions {
  /**
   * Accept restricted (scoped) sessions. Defaults to `false` — a fail-closed
   * default so full-access consumers (tRPC context, RSC caller, SSE, OAuth
   * authorize) automatically reject a scoped session (e.g. a Google Reader
   * token) as if it were invalid. Only surfaces that understand scoped sessions
   * (the Google Reader API) should pass `true`, and they must then check the
   * returned `session.scopes` themselves.
   */
  allowScoped?: boolean;
}

/**
 * Validates a session token and returns the session with user data.
 * Uses Redis cache for fast lookups, falls back to database on cache miss.
 * Returns null if the token is invalid, expired, or revoked.
 *
 * By default a restricted (non-NULL `scopes`) session is treated as invalid —
 * see {@link ValidateSessionOptions.allowScoped}.
 */
export async function validateSession(
  token: string,
  options?: ValidateSessionOptions
): Promise<SessionData | null> {
  const allowScoped = options?.allowScoped ?? false;
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
          // Reject a restricted session for full-access use (fail closed).
          if (data.session.scopes !== null && !allowScoped) {
            return null;
          }
          // Update last_active_at asynchronously (fire and forget)
          void updateLastActiveAt(data.session.id, data.session.userId);
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

  const dbResult = result[0];

  // Build SessionData with boolean flags; don't include decrypted API keys
  const sessionData: SessionData = {
    session: dbResult.session,
    user: {
      ...dbResult.user,
      groqApiKey: null, // Not cached for security; use getUserApiKeys() when needed
      anthropicApiKey: null, // Not cached for security; use getUserApiKeys() when needed
    },
    hasGroqApiKey: !!dbResult.user.groqApiKey,
    hasAnthropicApiKey: !!dbResult.user.anthropicApiKey,
  };

  // Cache the result in Redis (if available). We cache before applying the
  // scoped-access policy so a later opt-in caller still benefits from the cache.
  if (redis) {
    try {
      await redis.setex(cacheKey, SESSION_CACHE_TTL_SECONDS, serializeForCache(sessionData));
    } catch (err) {
      // Redis error - continue without caching
      console.error("Failed to cache session:", err);
    }
  }

  // Reject a restricted session for full-access use (fail closed).
  if (sessionData.session.scopes !== null && !allowScoped) {
    return null;
  }

  // Update last_active_at asynchronously (fire and forget)
  void updateLastActiveAt(sessionData.session.id, sessionData.session.userId);

  return sessionData;
}

/**
 * How stale the denormalized users.last_active_at may be before we refresh it.
 * The per-session timestamp updates on every request, but the user row only
 * needs to be roughly current (it feeds the admin activity view), so we skip
 * the write when it was updated within this window to avoid write/index churn.
 */
const USER_LAST_ACTIVE_REFRESH_MS = 60 * 1000;

/**
 * Updates last_active_at for both the session and (throttled) the user row.
 * Done asynchronously (fire-and-forget) so it never blocks the request.
 *
 * The user-row copy is denormalized so the admin "last active" view survives
 * session retention cleanup (expired sessions are deleted), rather than being
 * derived from MAX(sessions.last_active_at).
 *
 * This runs on every authenticated request, so it's a single round-trip via a
 * writable CTE rather than two sequential statements. The session row is always
 * touched; the user row is only touched when its timestamp is stale, so the
 * common case is a no-op on the users table (no row write, no index churn) while
 * still costing just one query.
 */
async function updateLastActiveAt(sessionId: string, userId: string): Promise<void> {
  const now = new Date();
  const staleCutoff = new Date(now.getTime() - USER_LAST_ACTIVE_REFRESH_MS);
  try {
    await db.execute(sql`
      WITH touched_session AS (
        UPDATE ${sessions} SET last_active_at = ${now} WHERE id = ${sessionId}
      )
      UPDATE ${users} SET last_active_at = ${now}
      WHERE id = ${userId}
        AND (last_active_at IS NULL OR last_active_at < ${staleCutoff})
    `);
  } catch (err) {
    console.error("Failed to update last_active_at:", err);
  }
}

// ============================================================================
// API Key Retrieval
// ============================================================================

/**
 * API keys fetched from the database on demand.
 */
export interface UserApiKeys {
  groqApiKey: string | null;
  anthropicApiKey: string | null;
}

/**
 * Fetches and decrypts a user's API keys from the database.
 *
 * API keys are intentionally not cached in the Redis session cache to prevent
 * exposure if Redis is compromised. This function should be called only when
 * the actual key values are needed (e.g., narration, summarization endpoints).
 */
export async function getUserApiKeys(userId: string): Promise<UserApiKeys> {
  const result = await db
    .select({
      groqApiKey: users.groqApiKey,
      anthropicApiKey: users.anthropicApiKey,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (result.length === 0) {
    return { groqApiKey: null, anthropicApiKey: null };
  }

  const { groqApiKey, anthropicApiKey } = result[0];

  return {
    groqApiKey: groqApiKey ? decryptApiKey(groqApiKey) : null,
    anthropicApiKey: anthropicApiKey ? decryptApiKey(anthropicApiKey) : null,
  };
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
 * Revokes all of a user's active sessions except one, and clears their Redis
 * caches. Used after a password change so a stolen/lingering session on another
 * device can't outlive the credential it was created under — the current session
 * (the one performing the change) is kept alive.
 *
 * @param userId - The user whose other sessions to revoke
 * @param exceptSessionId - The session ID to keep active
 * @returns The number of sessions revoked
 */
export async function revokeOtherUserSessions(
  userId: string,
  exceptSessionId: string
): Promise<number> {
  const revokeFilter = and(
    eq(sessions.userId, userId),
    isNull(sessions.revokedAt),
    ne(sessions.id, exceptSessionId)
  );

  // Capture the token hashes first so we can evict their cache entries after
  // the DB revoke (the cached copy still validates until its key is deleted).
  const toRevoke = await db
    .select({ tokenHash: sessions.tokenHash })
    .from(sessions)
    .where(revokeFilter);

  if (toRevoke.length === 0) {
    return 0;
  }

  await db.update(sessions).set({ revokedAt: new Date() }).where(revokeFilter);

  const redis = getRedisClient();
  if (redis) {
    try {
      const pipeline = redis.pipeline();
      for (const session of toRevoke) {
        pipeline.del(getCacheKey(session.tokenHash));
      }
      await pipeline.exec();
    } catch (err) {
      console.error("Failed to invalidate revoked session caches:", err);
    }
  }

  return toRevoke.length;
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

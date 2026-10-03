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

import { eq, and, isNull, ne, gt, sql } from "drizzle-orm";
import { db, type DbOrTx } from "@/server/db";
import { sessions, userApiKeys, users, type User, type Session } from "@/server/db/schema";
import { isAiProvider, type AiProvider } from "@/lib/ai/providers";
import type { AiProviderKeys } from "@/server/services/ai-providers";
import { generateUuidv7 } from "@/lib/uuidv7";
import { getRedisClient } from "@/server/redis";
import * as Sentry from "@sentry/nextjs";
import { assertEncryptionConfigured, decryptApiKey } from "@/lib/encryption";
import { UNREADABLE_API_KEY } from "@/server/services/unreadable-api-key";
import { OAUTH_SCOPES, generateToken, hashToken } from "@/server/oauth/utils";
import { errors } from "@/server/trpc/errors";
import { SESSION_MAX_AGE_SECONDS } from "@/server/auth/session-cookie";

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
 * Redis cache TTL for sessions (5 minutes)
 */
const SESSION_CACHE_TTL_SECONDS = 300;

/**
 * Redis key prefix for session cache.
 *
 * The version suffix namespaces the cached payload format; releases share
 * Redis during a rolling deploy. Bump it whenever a change to
 * {@link CachedSession} is security-relevant — e.g. adding the `scopes` field,
 * where a missing field would deserialize to a default (`scopes` → `null` →
 * full access), a fail-open for a scoped session — or removes a field the
 * previous release needs. Old-format entries under the previous prefix are
 * simply left to expire via TTL.
 */
const SESSION_CACHE_PREFIX = "session:v3:";

// ============================================================================
// Types
// ============================================================================

/**
 * Session data returned from validation
 */
export interface SessionData {
  session: Session;
  // Two columns are deliberately absent. greaderUserId is a bigint (uncacheable
  // in the Redis session JSON, and with no nullable placeholder) that only the
  // Google Reader user-info route needs — and it reads that straight from the
  // DB. gettingStartedAt is an onboarding bookkeeping marker with no request-path
  // reader at all, so caching it would only mean stale data to invalidate.
  user: Omit<User, "greaderUserId" | "gettingStartedAt">;
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
  userSummarizationModel: string | null;
  userSummarizationMaxWords: number | null;
  userSummarizationPrompt: string | null;
  userNarrationModel: string | null;
  userTosAgreedAt: string | null;
  userPrivacyPolicyAgreedAt: string | null;
  userNotEuAgreedAt: string | null;
}

// ============================================================================
// Session Expiry
// ============================================================================

/**
 * Calculates session expiry date
 */
function getSessionExpiry(): Date {
  return new Date(Date.now() + SESSION_MAX_AGE_SECONDS * 1000);
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
  const token = generateToken();
  const tokenHash = hashToken(token);
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
 * Evicts cached sessions (the cached copy still validates until its key is
 * deleted). Failures are logged, not thrown. `tokenHashes` must be non-empty.
 */
async function evictSessionCaches(tokenHashes: string[]): Promise<void> {
  const redis = getRedisClient();
  if (!redis) {
    return;
  }
  try {
    await redis.del(...tokenHashes.map(getCacheKey));
  } catch (err) {
    console.error("Failed to invalidate session cache:", err);
  }
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
    userSummarizationModel: data.user.summarizationModel ?? null,
    userSummarizationMaxWords: data.user.summarizationMaxWords ?? null,
    userSummarizationPrompt: data.user.summarizationPrompt ?? null,
    userNarrationModel: data.user.narrationModel ?? null,
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
      scopes: cached.scopes,
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
      inviteId: cached.userInviteId,
      showSpam: cached.userShowSpam,
      summarizationModel: cached.userSummarizationModel,
      summarizationMaxWords: cached.userSummarizationMaxWords,
      summarizationPrompt: cached.userSummarizationPrompt,
      narrationModel: cached.userNarrationModel,
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
          void updateLastActiveAt(
            data.session.id,
            data.session.userId,
            data.session.scopes !== null
          );
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

  const sessionData: SessionData = {
    session: dbResult.session,
    user: dbResult.user,
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
  void updateLastActiveAt(
    sessionData.session.id,
    sessionData.session.userId,
    sessionData.session.scopes !== null
  );

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
 * Updates last_active_at for the session and (throttled) the user row.
 * Done asynchronously (fire-and-forget) so it never blocks the request.
 *
 * The user-row copy is denormalized so the admin "last active" view survives
 * session retention cleanup (expired sessions are deleted), rather than being
 * derived from MAX(sessions.last_active_at).
 *
 * `isScoped` is true for a restricted (compat-API) session — today only the
 * Google Reader token, which a native app polls in the background. That polling
 * isn't real user activity, so a scoped session bumps **only** its own session
 * row (needed for the user's session list and as the admin "last API usage"
 * source, MAX(sessions.last_active_at) over scoped rows) and deliberately leaves
 * `users.last_active_at` alone — otherwise a native-app sync would keep a user
 * looking perpetually "active" (and inflate the active-users stats) despite
 * never opening the reader.
 *
 * For a full-access (browser) session this is a single round-trip via a
 * writable CTE rather than two sequential statements. The session row is always
 * touched; the user row is only touched when its timestamp is stale, so the
 * common case is a no-op on the users table (no row write, no index churn) while
 * still costing just one query.
 */
async function updateLastActiveAt(
  sessionId: string,
  userId: string,
  isScoped: boolean
): Promise<void> {
  const now = new Date();
  try {
    if (isScoped) {
      await db.execute(sql`
        UPDATE ${sessions} SET last_active_at = ${now} WHERE id = ${sessionId}
      `);
      return;
    }
    const staleCutoff = new Date(now.getTime() - USER_LAST_ACTIVE_REFRESH_MS);
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

/** The providers `userId` has their own API key for (not the keys). */
export async function getApiKeyProviders(userId: string): Promise<AiProvider[]> {
  const rows = await db
    .select({ provider: userApiKeys.provider })
    .from(userApiKeys)
    .where(eq(userApiKeys.userId, userId))
    .orderBy(userApiKeys.provider);
  return rows.map((row) => row.provider).filter(isAiProvider);
}

/**
 * Fetches and decrypts a user's API keys from the database.
 *
 * API keys are intentionally not cached in the Redis session cache to prevent
 * exposure if Redis is compromised. This function should be called only when
 * the actual key values are needed (e.g., narration, summarization endpoints).
 *
 * A missing or malformed `API_KEY_ENCRYPTION_KEY` throws. A key that doesn't
 * decrypt under it is reported and comes back as `UNREADABLE_API_KEY`, so
 * the user's other keys still work and that provider doesn't quietly move
 * onto the server's key. The row stays: a wrong (but well-formed) encryption
 * key fails every row, and fixing it should bring them all back.
 */
export async function getUserApiKeys(userId: string): Promise<AiProviderKeys> {
  const rows = await db
    .select({ provider: userApiKeys.provider, encryptedKey: userApiKeys.encryptedKey })
    .from(userApiKeys)
    .where(eq(userApiKeys.userId, userId));
  if (rows.length > 0) {
    assertEncryptionConfigured();
  }
  const keys: AiProviderKeys = {};
  for (const { provider, encryptedKey } of rows) {
    if (!isAiProvider(provider)) continue;
    try {
      keys[provider] = decryptApiKey(encryptedKey);
    } catch (err) {
      Sentry.captureException(err, {
        tags: { source: "api-key-decrypt", provider },
        extra: { userId },
      });
      keys[provider] = UNREADABLE_API_KEY;
    }
  }
  return keys;
}

/**
 * The providers whose saved key {@link getUserApiKeys} would find unreadable,
 * for Settings to ask for again. Never throws and reports nothing — that's for
 * actual use — and finds none when encryption isn't configured, where the
 * settings page hides keys altogether.
 */
export async function getUnreadableApiKeyProviders(userId: string): Promise<AiProvider[]> {
  try {
    assertEncryptionConfigured();
  } catch {
    return [];
  }
  const rows = await db
    .select({ provider: userApiKeys.provider, encryptedKey: userApiKeys.encryptedKey })
    .from(userApiKeys)
    .where(eq(userApiKeys.userId, userId))
    .orderBy(userApiKeys.provider);
  return rows
    .filter(({ encryptedKey }) => {
      try {
        decryptApiKey(encryptedKey);
        return false;
      } catch {
        return true;
      }
    })
    .map((row) => row.provider)
    .filter(isAiProvider);
}

/**
 * Whether a session is still usable — the same "not revoked, not expired" rule
 * `validateSession` applies, by id and without bumping `last_active_at`: for a
 * caller that captured the session **id** and has no token to re-validate (the
 * OAuth link callback, `oauth/config.ts` `OAuthLinkTarget`), or one re-checking
 * a session it already validated (the SSE stream). It doesn't check scopes, so
 * only pass it the id of a session that already passed `validateSession`.
 */
export async function isSessionActive(sessionId: string): Promise<boolean> {
  const rows = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(
      and(
        eq(sessions.id, sessionId),
        isNull(sessions.revokedAt),
        gt(sessions.expiresAt, new Date())
      )
    )
    .limit(1);

  return rows.length > 0;
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

  await evictSessionCaches([tokenHash]);

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

  // Revoke in database
  const result = await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.tokenHash, tokenHash), isNull(sessions.revokedAt)));

  await evictSessionCaches([tokenHash]);

  // Drizzle returns affected row count
  return result.rowCount !== null && result.rowCount > 0;
}

/**
 * Revokes all of a user's active sessions except one, and clears their Redis
 * caches. Used after a password change so a stolen/lingering session on another
 * device can't outlive the credential it was created under — the current session
 * (the one performing the change) is kept alive.
 *
 * Deliberately not exported: `revokeOtherUserSessionsOrReport` below is the only
 * caller, so every credential change gets that failure handling.
 *
 * @param userId - The user whose other sessions to revoke
 * @param exceptSessionId - The `sessions` row to keep active. Under token auth
 *   `ctx.session.session.id` is an `api_tokens` id, which matches no session and
 *   would take the caller's own sessions down with the rest — every caller must
 *   be session-only.
 * @returns The number of sessions revoked
 */
async function revokeOtherUserSessions(userId: string, exceptSessionId: string): Promise<number> {
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
  await evictSessionCaches(toRevoke.map((session) => session.tokenHash));

  return toRevoke.length;
}

/**
 * `revokeOtherUserSessions` for a credential change that has already been
 * written: reports a failed revoke instead of letting it look like the change
 * itself failed.
 *
 * The change deliberately stands. Removing (or adding) the credential is what
 * the user asked for and is the urgent half — an unlink rolled back because the
 * revoke failed would leave a provider account the user believes is compromised
 * still able to sign in. The cost is that retrying the action won't retry the
 * revoke: callers gate it on a credential having actually changed, so the second
 * attempt is a no-op. That's why the error names Settings → Sessions, where the
 * user can revoke the survivors by hand.
 *
 * @param change - what already happened, for the error message the user reads
 * @throws `sessionRevokeFailed`
 */
export async function revokeOtherUserSessionsOrReport(
  userId: string,
  exceptSessionId: string,
  change: string
): Promise<void> {
  try {
    await revokeOtherUserSessions(userId, exceptSessionId);
  } catch (err) {
    console.error("Failed to revoke other sessions after a credential change:", err);
    throw errors.sessionRevokeFailed(change);
  }
}

/**
 * Invalidates all session caches for a user without revoking the sessions.
 * Useful when user preferences are updated and cached session data needs refresh.
 *
 * @param userId - The user ID whose session caches to invalidate
 */
export async function invalidateUserSessionCaches(userId: string): Promise<void> {
  // If Redis is not available, nothing to invalidate
  if (!getRedisClient()) {
    return;
  }

  // Get all active sessions for this user
  const activeSessions = await db
    .select({ tokenHash: sessions.tokenHash })
    .from(sessions)
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));

  if (activeSessions.length > 0) {
    await evictSessionCaches(activeSessions.map((session) => session.tokenHash));
  }
}

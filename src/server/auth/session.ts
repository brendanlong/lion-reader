/**
 * Session Management
 *
 * Token format: 32 random bytes, base64url encoded
 * Storage: SHA-256 hash in database (never store raw tokens)
 */

import { eq, and, isNull, ne, gt, sql } from "drizzle-orm";
import { db, type DbOrTx } from "@/server/db";
import { sessions, users, type User, type Session } from "@/server/db/schema";
import { generateUuidv7 } from "@/lib/uuidv7";
import { OAUTH_SCOPES, generateToken, hashToken } from "@/server/oauth/utils";
import { errors } from "@/server/errors";
import { SESSION_MAX_AGE_SECONDS, setSessionCookie } from "@/server/auth/session-cookie";
import { extractClientInfo } from "@/server/http/client-ip";

/**
 * Scopes a session may be restricted to. A scoped session is a fail-closed
 * bearer credential (see {@link CreateSessionParams.scopes}); minting one with
 * an unrecognized scope would create a credential that silently matches nothing
 * everywhere, so we reject unknown scopes up front instead.
 */
const VALID_SESSION_SCOPES = new Set<string>(Object.values(OAUTH_SCOPES));

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

/**
 * Sign a user in: create a full-access browser session recording the request's
 * client, and set its cookie on `resHeaders` (absent on the REST/OpenAPI path,
 * whose clients take the returned token from the response body).
 */
export async function startSession(
  dbOrTx: DbOrTx,
  params: { userId: string; requestHeaders: Headers; resHeaders: Headers | undefined }
): Promise<CreateSessionResult> {
  const { userAgent, ipAddress } = extractClientInfo(params.requestHeaders);
  const result = await createSession(dbOrTx, { userId: params.userId, userAgent, ipAddress });
  setSessionCookie(params.resHeaders, result.token);
  return result;
}

// ============================================================================
// Session Validation
// ============================================================================

/**
 * Options for {@link validateSession}.
 */
export interface ValidateSessionOptions {
  /**
   * Accept restricted (scoped) sessions. Defaults to `false` — a fail-closed
   * default so full-access consumers (tRPC context, RSC caller, SSE, OAuth
   * authorize) automatically reject a scoped session (e.g. a Google Reader
   * token) as if it were invalid. `authenticateCredential` passes `true` only
   * for a surface that accepts the `scoped_session` kind, and checks its scopes.
   */
  allowScoped?: boolean;
}

/**
 * Validates a session token and returns the session with user data.
 * Returns null if the token is invalid, expired, or revoked.
 *
 * Deliberately uncached: in production a Redis round trip costs more than this
 * indexed lookup (#2046), and reading Postgres means revocations, preference
 * changes and account deletion take effect on the next request.
 *
 * By default a restricted (non-NULL `scopes`) session is treated as invalid —
 * see {@link ValidateSessionOptions.allowScoped}.
 */
export async function validateSession(
  token: string,
  options?: ValidateSessionOptions
): Promise<SessionData | null> {
  const allowScoped = options?.allowScoped ?? false;
  const now = new Date();
  const result = await db
    .select({
      session: sessions,
      user: users,
    })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(
      and(
        eq(sessions.tokenHash, hashToken(token)),
        isNull(sessions.revokedAt),
        gt(sessions.expiresAt, now)
      )
    )
    .limit(1);

  if (result.length === 0) {
    return null;
  }

  const sessionData = result[0];
  const isScoped = sessionData.session.scopes !== null;

  // Reject a restricted session for full-access use (fail closed).
  if (isScoped && !allowScoped) {
    return null;
  }

  const staleCutoff = now.getTime() - LAST_ACTIVE_REFRESH_MS;
  const userIsStale =
    !isScoped &&
    (sessionData.user.lastActiveAt === null ||
      sessionData.user.lastActiveAt.getTime() < staleCutoff);
  if (sessionData.session.lastActiveAt.getTime() < staleCutoff || userIsStale) {
    void updateLastActiveAt(sessionData.session.id, sessionData.session.userId, isScoped);
  }

  return sessionData;
}

/**
 * How stale a session's or user's last_active_at may be before we refresh it.
 * Both only need to be roughly current (the session list, the admin activity
 * view), so skipping writes within this window avoids per-request write churn.
 *
 * @testonly
 */
export const LAST_ACTIVE_REFRESH_MS = 60 * 1000;

/**
 * Updates last_active_at for the session and the user row, each throttled.
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
 * `validateSession` calls it only when the row it read is stale, so most
 * requests send no write; the statement re-checks staleness so concurrent
 * requests (or one user's several sessions) don't each rewrite the rows. For a
 * full-access (browser) session both rows go in one round trip via a writable
 * CTE.
 *
 * @testonly
 */
export async function updateLastActiveAt(
  sessionId: string,
  userId: string,
  isScoped: boolean
): Promise<void> {
  const now = new Date();
  const staleCutoff = new Date(now.getTime() - LAST_ACTIVE_REFRESH_MS);
  try {
    if (isScoped) {
      await db.execute(sql`
        UPDATE ${sessions} SET last_active_at = ${now}
        WHERE id = ${sessionId} AND last_active_at < ${staleCutoff}
      `);
      return;
    }
    await db.execute(sql`
      WITH touched_session AS (
        UPDATE ${sessions} SET last_active_at = ${now}
        WHERE id = ${sessionId} AND last_active_at < ${staleCutoff}
      )
      UPDATE ${users} SET last_active_at = ${now}
      WHERE id = ${userId}
        AND (last_active_at IS NULL OR last_active_at < ${staleCutoff})
    `);
  } catch (err) {
    console.error("Failed to update last_active_at:", err);
  }
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
 * Revokes one of `userId`'s active sessions.
 *
 * @returns false if `userId` has no active session with that id
 */
export async function revokeUserSession(userId: string, sessionId: string): Promise<boolean> {
  const revoked = await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId), isNull(sessions.revokedAt)))
    .returning({ id: sessions.id });

  return revoked.length > 0;
}

/**
 * Revokes a session by its token.
 *
 * @param token - The session token to revoke
 * @returns true if the session was revoked, false if not found
 */
export async function revokeSessionByToken(token: string): Promise<boolean> {
  const result = await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.tokenHash, hashToken(token)), isNull(sessions.revokedAt)));

  // Drizzle returns affected row count
  return result.rowCount !== null && result.rowCount > 0;
}

/**
 * Revokes all of a user's active sessions except one. Used after a password change so a stolen/lingering session on another
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
  const revoked = await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(
      and(eq(sessions.userId, userId), isNull(sessions.revokedAt), ne(sessions.id, exceptSessionId))
    )
    .returning({ id: sessions.id });

  return revoked.length;
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

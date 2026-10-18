/**
 * OAuth 2.1 Service
 *
 * Database operations for the OAuth authorization server's authorization
 * codes and tokens.
 */

import { eq, and, isNull, gt, inArray, sql } from "drizzle-orm";
import { db, type DbOrTx } from "@/server/db";
import {
  oauthAuthorizationCodes,
  oauthAccessTokens,
  oauthRefreshTokens,
  oauthConsentGrants,
  users,
  type User,
} from "@/server/db/schema";
import { generateUuidv7 } from "@/lib/uuidv7";
import {
  generateAccessToken,
  generateToken,
  hashToken,
  isLastUsedStale,
  validatePkceS256,
  getAccessTokenExpiry,
  getRefreshTokenExpiry,
  getAuthCodeExpiry,
} from "./utils";
import { logger } from "@/lib/logger";

// ============================================================================
// Types
// ============================================================================

/**
 * Token pair returned after authorization
 */
export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  /** Row id of the refresh token, which rotation links its predecessor to. */
  refreshTokenId: string;
  tokenType: "Bearer";
  expiresIn: number;
  scope: string;
}

/**
 * OAuth access token data for validation
 */
export interface OAuthTokenData {
  tokenId: string;
  expiresAt: Date;
  userId: string;
  clientId: string;
  scopes: string[];
  resource: string | null;
  user: User;
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
  const code = generateToken();
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
 *
 * Accepts an optional transaction/executor so callers that mint tokens as part
 * of a larger atomic operation (e.g. refresh rotation) can enroll the inserts in
 * their transaction. Defaults to the pooled `db`.
 */
export async function createTokens(
  params: CreateTokensParams,
  executor: DbOrTx = db
): Promise<TokenPair> {
  const accessToken = generateAccessToken();
  const refreshToken = generateToken();
  const accessTokenHash = hashToken(accessToken);
  const refreshTokenHash = hashToken(refreshToken);

  const accessTokenId = generateUuidv7();
  const refreshTokenId = generateUuidv7();

  const accessTokenExpiry = getAccessTokenExpiry();
  const refreshTokenExpiry = getRefreshTokenExpiry();

  // Insert access token
  await executor.insert(oauthAccessTokens).values({
    id: accessTokenId,
    tokenHash: accessTokenHash,
    clientId: params.clientId,
    userId: params.userId,
    scopes: params.scopes,
    resource: params.resource ?? null,
    expiresAt: accessTokenExpiry,
  });

  // Insert refresh token
  await executor.insert(oauthRefreshTokens).values({
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
    refreshTokenId,
    tokenType: "Bearer",
    expiresIn: Math.floor((accessTokenExpiry.getTime() - Date.now()) / 1000),
    scope: params.scopes.join(" "),
  };
}

/**
 * Takes a share lock on a user's row for the rest of `tx`, so that token
 * issuance and a credential change (which updates the row first, then revokes
 * the user's tokens) serialize: see {@link rotateRefreshToken}. Always lock the
 * user row before touching token rows, as credential changes do, so the two
 * can't deadlock. Returns the row's current password hash.
 */
export async function lockUserAgainstCredentialChange(
  tx: DbOrTx,
  userId: string
): Promise<{ passwordHash: string | null } | undefined> {
  const [row] = await tx
    .select({ passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.id, userId))
    .for("share");
  return row;
}

/**
 * Whether an access token is still usable — the same "not revoked, not
 * expired" rule `validateAccessToken` applies, by id and without bumping
 * `last_used_at`, for a caller re-checking a token it already validated.
 */
export async function isAccessTokenActive(tokenId: string): Promise<boolean> {
  const rows = await db
    .select({ id: oauthAccessTokens.id })
    .from(oauthAccessTokens)
    .where(
      and(
        eq(oauthAccessTokens.id, tokenId),
        isNull(oauthAccessTokens.revokedAt),
        gt(oauthAccessTokens.expiresAt, new Date())
      )
    )
    .limit(1);

  return rows.length > 0;
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

  if (isLastUsedStale(accessToken.lastUsedAt)) {
    void updateAccessTokenLastUsed(accessToken.id);
  }

  return {
    tokenId: accessToken.id,
    expiresAt: accessToken.expiresAt,
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
 * Presenting an already-rotated (revoked but unexpired) token *outside* a short
 * grace window is treated as rotation reuse — evidence the token leaked — and
 * revokes the leaked token's rotation chain (see handlePossibleRefreshTokenReuse).
 *
 * The claim, old-token revocation, successor creation, and chain link all run in
 * a single transaction. That's not just tidiness: if the successor were created
 * and the process died before `replaced_by_id` was stamped, the successor would
 * be live but unreachable from the chain walk, so reuse detection could never
 * revoke it. Wrapping the whole sequence means either the fully-linked successor
 * exists or nothing does, and a failure leaves the presented token valid to retry.
 *
 * The transaction first takes a share lock on the owner's `users` row, which is
 * what a credential change updates before it sweeps the user's tokens. Without
 * it, a rotation whose successor committed after the sweep's snapshot would
 * leave a live token behind; with it, one waits for the other, so either the
 * sweep sees the successor or the rotation sees its token already revoked.
 */
export async function rotateRefreshToken(
  refreshToken: string,
  clientId: string,
  options: { requireUserConsent?: boolean } = {}
): Promise<TokenPair | null> {
  const tokenHash = hashToken(refreshToken);
  const now = new Date();

  const [owner] = await db
    .select({ userId: oauthRefreshTokens.userId })
    .from(oauthRefreshTokens)
    .where(eq(oauthRefreshTokens.tokenHash, tokenHash))
    .limit(1);

  const result = await db.transaction(async (tx): Promise<RotationResult> => {
    if (owner) {
      await lockUserAgainstCredentialChange(tx, owner.userId);
    }

    // Atomically claim (revoke) the presented refresh token
    const claimed = await tx
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
      // Nothing claimed — roll back (a no-op) and let the caller run reuse
      // detection outside the transaction.
      return { rejected: "no_claim" };
    }

    const oldRefreshToken = claimed[0];

    // A user who revoked this client in Settings must not be walked back in by
    // a refresh: the consent grant is what suppresses the consent prompt, so a
    // live rotation chain would silently outlive the revocation. Checked here
    // rather than in the revocation sweep because a rotation racing the sweep
    // can commit a successor the sweep's snapshot never sees; that successor is
    // then born unusable. Only for OAuth-server flows — the Wallabag password
    // grant shares this rotation path and has no consent grant to check.
    if (options.requireUserConsent) {
      const activeGrant = await tx
        .select({ id: oauthConsentGrants.id })
        .from(oauthConsentGrants)
        .where(
          and(
            eq(oauthConsentGrants.userId, oldRefreshToken.userId),
            eq(oauthConsentGrants.clientId, clientId),
            isNull(oauthConsentGrants.revokedAt)
          )
        )
        .limit(1);

      if (activeGrant.length === 0) {
        // The claim stands (the presented token is revoked): consent is gone,
        // so the whole chain should be dead anyway.
        return { rejected: "no_consent" };
      }
    }

    // Revoke the old access token if it exists
    if (oldRefreshToken.accessTokenId) {
      await tx
        .update(oauthAccessTokens)
        .set({ revokedAt: now })
        .where(eq(oauthAccessTokens.id, oldRefreshToken.accessTokenId));
    }

    // Preserve the token's own audience across rotation. Don't stamp the MCP
    // audience onto every rotated token: the Wallabag compat API shares this
    // rotation path and mints tokens with a null resource, so forcing the MCP
    // identifier would mislabel a Wallabag credential as MCP-audienced.
    const created = await createTokens(
      {
        clientId: oldRefreshToken.clientId,
        userId: oldRefreshToken.userId,
        scopes: oldRefreshToken.scopes,
        resource: oldRefreshToken.resource,
      },
      tx
    );

    // Link the rotation chain on the old token
    await tx
      .update(oauthRefreshTokens)
      .set({ replacedById: created.refreshTokenId })
      .where(eq(oauthRefreshTokens.id, oldRefreshToken.id));

    return { tokens: created };
  });

  if ("rejected" in result) {
    if (result.rejected === "no_consent") {
      logger.warn("OAuth refresh rejected: user revoked this client's consent", {
        component: "oauth",
        clientId,
      });
      return null;
    }

    // The claim matched nothing: the token was unknown, expired, or already
    // rotated. The last case is either a genuine reuse (leak) or a benign
    // concurrent refresh racing the winner — handlePossibleRefreshTokenReuse
    // distinguishes them by how long ago the token was revoked.
    await handlePossibleRefreshTokenReuse(tokenHash, clientId, now);
    return null;
  }

  return result.tokens;
}

type RotationResult = { tokens: TokenPair } | { rejected: "no_claim" | "no_consent" };

/**
 * Grace window for rotation reuse detection. A rotated (revoked) refresh token
 * presented again within this window of its revocation is treated as a **benign
 * concurrent rotation**, not a leak: the common case is a client firing several
 * API calls in parallel, each triggering a refresh with the same token — exactly
 * one wins and the losers present the just-revoked token milliseconds later. If
 * that were treated as reuse we'd revoke the winner's freshly-minted chain and
 * leave the client with no valid tokens on *every* concurrent refresh (this was
 * empirically the dominant cause of flaky Wallabag sync, since its clients batch
 * requests). A genuine stolen-token replay lands well outside this window and is
 * still caught. Kept short to bound the window in which a real replay is missed.
 */
const REFRESH_ROTATION_REUSE_GRACE_MS = 10_000;

/**
 * Rotation-reuse detection: if a rotation attempt failed because the token was
 * already revoked (but is otherwise valid and unexpired), someone is replaying
 * an old refresh token. Revoke the leaked token's rotation **chain** (the family
 * descending from it) so that chain is dead no matter which copy the replayer
 * holds.
 *
 * The blast radius is deliberately the family, **not** every token the user holds
 * for this client. Revoking user+client-wide is over-broad: because every
 * Wallabag credential is minted under the single shared client_id "wallabag"
 * (see wallabag/auth.ts), a user+client-wide revoke signs the user out of *every*
 * Wallabag device on a single stale-token replay — which is exactly the flaky
 * "had to re-set-up / re-login" behavior we were seeing. OAuth 2.1 rotation
 * guidance (RFC 9700 §4.14.2) scopes reuse revocation to the token family/grant,
 * which is what we do here.
 *
 * The chain is strictly linear — each rotation atomically claims exactly one
 * predecessor and stamps its `replaced_by_id` — so walking `replaced_by_id`
 * forward from the presented (already-revoked) token reaches whichever branch is
 * currently active. Ancestors are already revoked (rotation revokes as it goes),
 * so only the forward descendants can still be live.
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

  // Revoked without being rotated (a password change, a Connected Apps revoke,
  // an earlier reuse sweep): nothing descends from it, and a client still
  // presenting it is out of date, not evidence of a leak.
  if (!presented.replacedById) {
    return;
  }

  // Benign-concurrency grace (see REFRESH_ROTATION_REUSE_GRACE_MS): a token
  // revoked a moment ago was almost certainly just rotated by a racing refresh
  // from the same client, not replayed by an attacker. Skip revocation so the
  // winner's live successor survives.
  //
  // `now` is deliberately the *request-start* time (captured at the top of
  // rotateRefreshToken), not a fresh timestamp sampled here: it measures how long
  // after revocation this request began presenting the token, i.e. whether it was
  // initiated concurrently with the rotation. That's exactly what we want — a
  // request that genuinely started alongside the winner stays inside the window
  // even if it's then delayed (DB contention, GC) for seconds before reaching
  // this check. Re-sampling the clock here would instead measure wall-time-to-
  // arrival and wrongly flag a slow-but-concurrent loser as reuse, revoking the
  // winner's fresh chain — the very flake this fixes. Keep the start-time anchor.
  if (now.getTime() - presented.revokedAt.getTime() <= REFRESH_ROTATION_REUSE_GRACE_MS) {
    return;
  }

  // Walk the rotation chain forward from the presented token via replaced_by_id.
  const familyRows = (
    await db.execute(sql`
      WITH RECURSIVE family AS (
        SELECT id, replaced_by_id, access_token_id
        FROM oauth_refresh_tokens
        WHERE id = ${presented.id}
        UNION ALL
        SELECT rt.id, rt.replaced_by_id, rt.access_token_id
        FROM oauth_refresh_tokens rt
        JOIN family f ON rt.id = f.replaced_by_id
      )
      SELECT id, access_token_id FROM family
    `)
  ).rows as Array<{ id: string; access_token_id: string | null }>;

  const refreshIds = familyRows.map((r) => r.id);
  const accessIds = familyRows
    .map((r) => r.access_token_id)
    .filter((id): id is string => id !== null);

  const revokedRefresh = await db
    .update(oauthRefreshTokens)
    .set({ revokedAt: now })
    .where(and(inArray(oauthRefreshTokens.id, refreshIds), isNull(oauthRefreshTokens.revokedAt)))
    .returning({ id: oauthRefreshTokens.id });

  let revokedAccessCount = 0;
  if (accessIds.length > 0) {
    const revokedAccess = await db
      .update(oauthAccessTokens)
      .set({ revokedAt: now })
      .where(and(inArray(oauthAccessTokens.id, accessIds), isNull(oauthAccessTokens.revokedAt)))
      .returning({ id: oauthAccessTokens.id });
    revokedAccessCount = revokedAccess.length;
  }

  logger.warn("OAuth refresh token reuse detected; revoked leaked rotation chain", {
    component: "oauth",
    userId: presented.userId,
    clientId,
    familySize: refreshIds.length,
    refreshTokensRevoked: revokedRefresh.length,
    accessTokensRevoked: revokedAccessCount,
  });
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

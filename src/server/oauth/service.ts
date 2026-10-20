/**
 * OAuth 2.1 Service
 *
 * Database operations for the OAuth authorization server's authorization
 * codes and tokens.
 */

import {
  eq,
  and,
  arrayContains,
  isNull,
  gt,
  inArray,
  or,
  type SQL,
  type SQLWrapper,
} from "drizzle-orm";
import { db, type DbOrTx } from "@/server/db";
import {
  oauthAuthorizationCodes,
  oauthAccessTokens,
  oauthConsentGrants,
  oauthRefreshTokens,
  oauthTokenGrants,
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
import { isForeignKeyViolation } from "@/server/db/errors";
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

interface AuthCodeExchange {
  userId: string;
  resource: string | null;
  tokens: TokenPair;
}

/**
 * Redeems an authorization code for a new grant and its first token pair.
 * Returns null if the code isn't redeemable, PKCE fails, or the user no longer
 * consents to the client.
 *
 * Consumption is a single atomic UPDATE ... WHERE used_at IS NULL, so of two
 * concurrent token requests presenting the same code exactly one succeeds
 * (OAuth 2.1 single-use requirement). The code is claimed before PKCE
 * verification, so a failed PKCE attempt also burns the code — that's the
 * safe direction (an attacker who stole a code can't retry verifiers).
 *
 * The new grant references the consent grant, so a Connected Apps revoke
 * (which deletes the consent) either cascades to it or makes the insert fail
 * its foreign key; checking consent at /oauth/authorize alone wouldn't stop a
 * code issued just after a revoke.
 */
export async function exchangeAuthorizationCode(
  code: string,
  clientId: string,
  redirectUri: string,
  codeVerifier: string
): Promise<AuthCodeExchange | null> {
  const [authCode] = await db
    .update(oauthAuthorizationCodes)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(oauthAuthorizationCodes.codeHash, hashToken(code)),
        eq(oauthAuthorizationCodes.clientId, clientId),
        eq(oauthAuthorizationCodes.redirectUri, redirectUri),
        isNull(oauthAuthorizationCodes.usedAt),
        gt(oauthAuthorizationCodes.expiresAt, new Date())
      )
    )
    .returning();

  if (!authCode) {
    // The atomic claim matched nothing: the code is unknown, already used,
    // expired, or the client_id / redirect_uri don't match what was stored.
    logger.warn("OAuth code exchange rejected: code claim failed", { clientId, redirectUri });
    return null;
  }

  if (!validatePkceS256(codeVerifier, authCode.codeChallenge)) {
    logger.warn("OAuth code exchange rejected: PKCE verification failed", { clientId });
    return null;
  }

  const [consent] = await db
    .select({ id: oauthConsentGrants.id })
    .from(oauthConsentGrants)
    .where(
      and(
        eq(oauthConsentGrants.userId, authCode.userId),
        eq(oauthConsentGrants.clientId, clientId),
        arrayContains(oauthConsentGrants.scopes, authCode.scopes)
      )
    );

  const rejectRevoked = (): null => {
    logger.warn("OAuth code exchange rejected: user revoked this client's consent", {
      component: "oauth",
      clientId,
      userId: authCode.userId,
    });
    return null;
  };
  if (!consent) {
    return rejectRevoked();
  }

  try {
    const tokens = await createTokens({
      clientId,
      userId: authCode.userId,
      consentGrantId: consent.id,
      scopes: authCode.scopes,
      resource: authCode.resource,
    });
    return { userId: authCode.userId, resource: authCode.resource, tokens };
  } catch (error) {
    // The consent was deleted after the lookup above.
    if (isForeignKeyViolation(error)) {
      return rejectRevoked();
    }
    throw error;
  }
}

// ============================================================================
// Token Management
// ============================================================================

interface CreateTokensParams {
  clientId: string;
  userId: string;
  /** The consent behind a code exchange; null only for the Wallabag password grant. */
  consentGrantId: string | null;
  scopes: string[];
  resource?: string | null;
}

type TokenGrant = Omit<typeof oauthTokenGrants.$inferSelect, "createdAt">;

/**
 * Starts a new authorization (a code exchange or a Wallabag password grant):
 * a grant and its first access/refresh token pair.
 */
export async function createTokens(params: CreateTokensParams): Promise<TokenPair> {
  const grant: TokenGrant = {
    id: generateUuidv7(),
    clientId: params.clientId,
    userId: params.userId,
    consentGrantId: params.consentGrantId,
    scopes: params.scopes,
    resource: params.resource ?? null,
  };
  return db.transaction(async (tx) => {
    await tx.insert(oauthTokenGrants).values(grant);
    return (await insertTokenPair(tx, grant)).tokens;
  });
}

/**
 * Mints an access/refresh token pair in `grant`. The rows repeat the grant's
 * scopes and resource only because the previous release reads them there
 * (#2053).
 */
async function insertTokenPair(
  executor: DbOrTx,
  grant: TokenGrant
): Promise<{ tokens: TokenPair; refreshTokenId: string }> {
  const accessToken = generateAccessToken();
  const refreshToken = generateToken();
  const accessTokenId = generateUuidv7();
  const refreshTokenId = generateUuidv7();
  const accessTokenExpiry = getAccessTokenExpiry();

  const tokenColumns = {
    grantId: grant.id,
    clientId: grant.clientId,
    userId: grant.userId,
    scopes: grant.scopes,
    resource: grant.resource,
  };

  await executor.insert(oauthAccessTokens).values({
    ...tokenColumns,
    id: accessTokenId,
    tokenHash: hashToken(accessToken),
    expiresAt: accessTokenExpiry,
  });

  await executor.insert(oauthRefreshTokens).values({
    ...tokenColumns,
    id: refreshTokenId,
    tokenHash: hashToken(refreshToken),
    accessTokenId,
    expiresAt: getRefreshTokenExpiry(),
  });

  return {
    tokens: {
      accessToken,
      refreshToken,
      tokenType: "Bearer",
      expiresIn: Math.floor((accessTokenExpiry.getTime() - Date.now()) / 1000),
      scope: grant.scopes.join(" "),
    },
    refreshTokenId,
  };
}

/**
 * Deletes the matching grants, and with them every token minted from them.
 * A rotation inserting into one of them waits for the delete or makes it wait
 * (see rotateRefreshToken), so its successor can't survive.
 */
export async function deleteTokenGrants(condition: SQL, executor: DbOrTx = db): Promise<number> {
  return executor.transaction(async (tx) => {
    await lockUsersAgainstPreviousReleaseRotation(
      tx,
      tx.select({ id: oauthTokenGrants.userId }).from(oauthTokenGrants).where(condition)
    );
    const deleted = await tx
      .delete(oauthTokenGrants)
      .where(condition)
      .returning({ id: oauthTokenGrants.id });
    return deleted.length;
  });
}

/**
 * Locks the users rows before a delete cascades to their tokens. The previous
 * release's rotation share-locks the user, claims the refresh token and only
 * then locks the grant, the reverse of a cascading delete; serializing on the
 * user row first keeps the two from deadlocking (#2053).
 */
export async function lockUsersAgainstPreviousReleaseRotation(
  tx: DbOrTx,
  userIds: string[] | SQLWrapper
): Promise<void> {
  await tx
    .select({ id: users.id })
    .from(users)
    .where(inArray(users.id, userIds))
    .orderBy(users.id)
    .for("no key update");
}

/**
 * Whether an access token is still usable — the same rule `validateAccessToken`
 * applies, by id and without bumping `last_used_at`, for a caller re-checking a
 * token it already validated.
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
      grant: oauthTokenGrants,
      user: users,
    })
    .from(oauthAccessTokens)
    .innerJoin(oauthTokenGrants, eq(oauthTokenGrants.id, oauthAccessTokens.grantId))
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

  const { token: accessToken, grant, user } = result[0];

  if (isLastUsedStale(accessToken.lastUsedAt)) {
    void updateAccessTokenLastUsed(accessToken.id);
  }

  return {
    tokenId: accessToken.id,
    expiresAt: accessToken.expiresAt,
    userId: grant.userId,
    clientId: grant.clientId,
    scopes: grant.scopes,
    resource: grant.resource,
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
 * Validates a refresh token and rotates it: the presented token and its access
 * token are revoked and a new pair is minted in the same grant.
 *
 * The presented token is claimed with an atomic UPDATE ... WHERE revoked_at IS
 * NULL, so concurrent requests with the same token can't both rotate it.
 * Presenting an already-rotated (revoked but unexpired) token *outside* a short
 * grace window is treated as rotation reuse — evidence the token leaked — and
 * deletes its grant (see handlePossibleRefreshTokenReuse).
 *
 * The claim and the new pair commit together, so a failure leaves the presented
 * token valid to retry. The grant row is key-share locked first, as inserting
 * the successor would lock it anyway: a delete of the grant then either waits
 * for this rotation and cascades to its successor, or commits first and the
 * claim finds nothing. Taking it before the claim keeps the lock order (grant,
 * then tokens) a cascading delete uses, so the two can't deadlock.
 */
export async function rotateRefreshToken(
  refreshToken: string,
  clientId: string
): Promise<TokenPair | null> {
  const tokenHash = hashToken(refreshToken);
  const now = new Date();

  const [owner] = await db
    .select({
      userId: oauthRefreshTokens.userId,
      grantId: oauthRefreshTokens.grantId,
      accessTokenId: oauthRefreshTokens.accessTokenId,
    })
    .from(oauthRefreshTokens)
    .where(eq(oauthRefreshTokens.tokenHash, tokenHash))
    .limit(1);

  const tokens = await db.transaction(async (tx): Promise<TokenPair | null> => {
    if (!owner) {
      return null;
    }

    // The previous release's password change and Wallabag sign-out lock the
    // user row, then revoke token rows a successor uncommitted here would
    // escape (#2053).
    await tx.select({ id: users.id }).from(users).where(eq(users.id, owner.userId)).for("share");
    const [grant] = await tx
      .select()
      .from(oauthTokenGrants)
      .where(eq(oauthTokenGrants.id, owner.grantId))
      .for("key share");
    if (!grant) {
      return null;
    }

    // Retention deletes expired access tokens, and the delete cascades to the
    // paired refresh row. Locking the access token before claiming the refresh
    // token takes the two in the same order, so the two can't deadlock (#2069).
    if (owner.accessTokenId) {
      await tx
        .select({ id: oauthAccessTokens.id })
        .from(oauthAccessTokens)
        .where(eq(oauthAccessTokens.id, owner.accessTokenId))
        .for("no key update");
    }

    const [claimed] = await tx
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
      .returning({ id: oauthRefreshTokens.id, accessTokenId: oauthRefreshTokens.accessTokenId });

    if (!claimed) {
      return null;
    }

    if (claimed.accessTokenId) {
      await tx
        .update(oauthAccessTokens)
        .set({ revokedAt: now })
        .where(eq(oauthAccessTokens.id, claimed.accessTokenId));
    }

    // The successor inherits the grant's own audience. Wallabag shares this
    // path with a null resource, so never stamp the MCP identifier here.
    const created = await insertTokenPair(tx, grant);

    // Only the previous release's reuse detection follows this link (#2053).
    await tx
      .update(oauthRefreshTokens)
      .set({ replacedById: created.refreshTokenId })
      .where(eq(oauthRefreshTokens.id, claimed.id));

    return created.tokens;
  });

  if (!tokens) {
    // Nothing was claimed: the token was unknown, expired, already rotated, or
    // its grant was deleted. A rotated token is either a genuine reuse (leak)
    // or a benign concurrent refresh racing the winner —
    // handlePossibleRefreshTokenReuse tells them apart.
    await handlePossibleRefreshTokenReuse(tokenHash, clientId, now);
  }

  return tokens;
}

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
 * already rotated (revoked but unexpired), someone is replaying it. Delete its
 * grant so the chain is dead no matter which copy the replayer holds.
 *
 * The blast radius is deliberately the grant, **not** every token the user holds
 * for this client. Revoking user+client-wide is over-broad: because every
 * Wallabag credential is minted under the single shared client_id "wallabag"
 * (see wallabag/auth.ts), a user+client-wide revoke signs the user out of *every*
 * Wallabag device on a single stale-token replay — which is exactly the flaky
 * "had to re-set-up / re-login" behavior we were seeing. OAuth 2.1 rotation
 * guidance (RFC 9700 §4.14.2) scopes reuse revocation to the token family/grant,
 * which is what we do here.
 */
async function handlePossibleRefreshTokenReuse(
  tokenHash: string,
  clientId: string,
  now: Date
): Promise<void> {
  const [presented] = await db
    .select({
      userId: oauthRefreshTokens.userId,
      revokedAt: oauthRefreshTokens.revokedAt,
      expiresAt: oauthRefreshTokens.expiresAt,
      grantId: oauthRefreshTokens.grantId,
    })
    .from(oauthRefreshTokens)
    .where(
      and(eq(oauthRefreshTokens.tokenHash, tokenHash), eq(oauthRefreshTokens.clientId, clientId))
    )
    .limit(1);

  if (!presented || !presented.revokedAt || presented.expiresAt <= now) {
    // Unknown (including a deleted grant's) or merely expired token — not
    // reuse, nothing to do
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

  await deleteTokenGrants(eq(oauthTokenGrants.id, presented.grantId));

  logger.warn("OAuth refresh token reuse detected; deleted its grant", {
    component: "oauth",
    userId: presented.userId,
    clientId,
    grantId: presented.grantId,
  });
}

/**
 * Revokes a token presented by a client (RFC 7009).
 *
 * The token may be an access token or a refresh token; both tables are checked
 * regardless of any `token_type_hint` (the RFC allows extending the search).
 * Either one deletes its whole grant (RFC 7009 §2.1: the server SHOULD
 * invalidate related tokens, and MAY revoke the refresh token behind an access
 * token).
 *
 * Only tokens belonging to `clientId` are revoked — a token owned by another
 * client is treated like an unknown token (a silent no-op), which is also what
 * the caller reports: RFC 7009 requires HTTP 200 for unknown tokens.
 */
export async function revokeClientToken(clientId: string, token: string): Promise<void> {
  const tokenHash = hashToken(token);

  await deleteTokenGrants(
    and(
      eq(oauthTokenGrants.clientId, clientId),
      or(
        inArray(
          oauthTokenGrants.id,
          db
            .select({ id: oauthAccessTokens.grantId })
            .from(oauthAccessTokens)
            .where(eq(oauthAccessTokens.tokenHash, tokenHash))
        ),
        inArray(
          oauthTokenGrants.id,
          db
            .select({ id: oauthRefreshTokens.grantId })
            .from(oauthRefreshTokens)
            .where(eq(oauthRefreshTokens.tokenHash, tokenHash))
        )
      )
    )!
  );
}

/**
 * OAuth 2.1 Service
 *
 * Database operations for the OAuth authorization server's authorization
 * codes and tokens.
 */

import { eq, and, arrayContains, isNull, isNotNull, gt, inArray, or, type SQL } from "drizzle-orm";
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
 * Returns null if the code isn't redeemable or PKCE fails.
 *
 * Consumption is a single atomic UPDATE ... WHERE used_at IS NULL, so of two
 * concurrent token requests presenting the same code exactly one succeeds
 * (OAuth 2.1 single-use requirement). The code is claimed before PKCE
 * verification, so a failed PKCE attempt also burns the code — that's the
 * safe direction (an attacker who stole a code can't retry verifiers).
 *
 * The exchange holds a share lock on the user's consent grant until the new
 * grant commits, and a Connected Apps revoke updates that row first and kills
 * codes and grants in the same transaction, so the two serialize: the revoke
 * either sees this exchange's grant or commits before it, and the exchange then
 * finds no consent. Checking consent at /oauth/authorize alone isn't enough,
 * since a code issued just after a revoke would outlive it.
 */
export async function exchangeAuthorizationCode(
  code: string,
  clientId: string,
  redirectUri: string,
  codeVerifier: string
): Promise<AuthCodeExchange | null> {
  const codeHash = hashToken(code);

  return db.transaction(async (tx) => {
    const [pending] = await tx
      .select({ userId: oauthAuthorizationCodes.userId, scopes: oauthAuthorizationCodes.scopes })
      .from(oauthAuthorizationCodes)
      .where(eq(oauthAuthorizationCodes.codeHash, codeHash))
      .limit(1);
    const consent =
      pending &&
      (await tx
        .select({ id: oauthConsentGrants.id })
        .from(oauthConsentGrants)
        .where(
          and(
            eq(oauthConsentGrants.userId, pending.userId),
            eq(oauthConsentGrants.clientId, clientId),
            isNull(oauthConsentGrants.revokedAt),
            arrayContains(oauthConsentGrants.scopes, pending.scopes)
          )
        )
        .for("share"));
    if (pending && consent?.length === 0) {
      logger.warn("OAuth code exchange rejected: user revoked this client's consent", {
        component: "oauth",
        clientId,
        userId: pending.userId,
      });
      return null;
    }

    const [authCode] = await tx
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

    if (!authCode) {
      // The atomic claim matched nothing: the code is unknown, already used,
      // expired, or the client_id / redirect_uri don't match what was stored.
      logger.warn("OAuth code exchange rejected: code claim failed", {
        clientId,
        redirectUri,
      });
      return null;
    }

    // Returning (not throwing) commits the claim, burning the code.
    if (!validatePkceS256(codeVerifier, authCode.codeChallenge)) {
      logger.warn("OAuth code exchange rejected: PKCE verification failed", { clientId });
      return null;
    }

    const tokens = await createTokens(
      {
        clientId,
        userId: authCode.userId,
        scopes: authCode.scopes,
        resource: authCode.resource,
      },
      tx
    );

    return { userId: authCode.userId, resource: authCode.resource, tokens };
  });
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

type TokenGrant = Omit<typeof oauthTokenGrants.$inferSelect, "createdAt" | "revokedAt">;

/**
 * Starts a new authorization (a code exchange or a Wallabag password grant):
 * a grant and its first access/refresh token pair.
 */
export async function createTokens(
  params: CreateTokensParams,
  executor: DbOrTx = db
): Promise<TokenPair> {
  const grant: TokenGrant = {
    id: generateUuidv7(),
    clientId: params.clientId,
    userId: params.userId,
    scopes: params.scopes,
    resource: params.resource ?? null,
  };
  return executor.transaction(async (tx) => {
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
 * Revokes the matching live grants, which ends every token minted from them,
 * including one a racing rotation commits afterwards. Returns how many grants
 * it revoked.
 *
 * It also stamps the token rows of every matching revoked grant, not just the
 * ones it revokes, only because the previous release checks nothing else
 * (#2053): repeating a revoke then catches rows that release committed into an
 * already-revoked grant.
 */
export async function revokeTokenGrants(
  condition: SQL,
  executor: DbOrTx = db,
  now: Date = new Date()
): Promise<number> {
  return executor.transaction(async (tx) => {
    const revoked = await tx
      .update(oauthTokenGrants)
      .set({ revokedAt: now })
      .where(and(condition, isNull(oauthTokenGrants.revokedAt)))
      .returning({ id: oauthTokenGrants.id });

    const revokedGrants = tx
      .select({ id: oauthTokenGrants.id })
      .from(oauthTokenGrants)
      .where(and(condition, isNotNull(oauthTokenGrants.revokedAt)));
    await tx
      .update(oauthRefreshTokens)
      .set({ revokedAt: now })
      .where(
        and(
          inArray(oauthRefreshTokens.grantId, revokedGrants),
          isNull(oauthRefreshTokens.revokedAt)
        )
      );
    await tx
      .update(oauthAccessTokens)
      .set({ revokedAt: now })
      .where(
        and(inArray(oauthAccessTokens.grantId, revokedGrants), isNull(oauthAccessTokens.revokedAt))
      );

    return revoked.length;
  });
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
    .innerJoin(oauthTokenGrants, eq(oauthTokenGrants.id, oauthAccessTokens.grantId))
    .where(
      and(
        eq(oauthAccessTokens.id, tokenId),
        isNull(oauthAccessTokens.revokedAt),
        gt(oauthAccessTokens.expiresAt, new Date()),
        isNull(oauthTokenGrants.revokedAt)
      )
    )
    .limit(1);

  return rows.length > 0;
}

/**
 * Validates an access token and returns the token data. The token must be
 * unrevoked and unexpired, and so must its grant.
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
        gt(oauthAccessTokens.expiresAt, new Date()),
        isNull(oauthTokenGrants.revokedAt)
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
 * Serializes a rotation with anything that could revoke the chain while its
 * successor is uncommitted, for the previous release's sake only (#2053): that
 * release validates only token rows, so a sweep must not miss the successor.
 * The user row is what that release's password change and Wallabag sign-out
 * lock before sweeping, and the grant row is what `revokeTokenGrants` updates
 * before stamping rows. Lock order: user, grant, refresh token, access token.
 */
async function lockForRotation(tx: DbOrTx, userId: string, grantId: string): Promise<void> {
  await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for("share");
  await tx
    .select({ id: oauthTokenGrants.id })
    .from(oauthTokenGrants)
    .where(eq(oauthTokenGrants.id, grantId))
    .for("share");
}

/**
 * Validates a refresh token and rotates it: the presented token and its access
 * token are revoked and a new pair is minted in the same grant.
 *
 * The presented token is claimed with an atomic UPDATE ... WHERE revoked_at IS
 * NULL, so concurrent requests with the same token can't both rotate it.
 * Presenting an already-rotated (revoked but unexpired) token *outside* a short
 * grace window is treated as rotation reuse — evidence the token leaked — and
 * revokes its grant (see handlePossibleRefreshTokenReuse).
 *
 * The claim and the new pair commit together, so a failure leaves the presented
 * token valid to retry. A revocation that lands mid-rotation revokes the grant
 * the successor is born into, so on this release nothing else needs to be
 * serialized (see lockForRotation for the previous release).
 */
export async function rotateRefreshToken(
  refreshToken: string,
  clientId: string
): Promise<TokenPair | null> {
  const tokenHash = hashToken(refreshToken);
  const now = new Date();

  const [owner] = await db
    .select({ userId: oauthRefreshTokens.userId, grantId: oauthRefreshTokens.grantId })
    .from(oauthRefreshTokens)
    .where(eq(oauthRefreshTokens.tokenHash, tokenHash))
    .limit(1);

  const tokens = await db.transaction(async (tx): Promise<TokenPair | null> => {
    if (owner) {
      await lockForRotation(tx, owner.userId, owner.grantId);
    }

    const [claimed] = await tx
      .update(oauthRefreshTokens)
      .set({ revokedAt: now })
      .from(oauthTokenGrants)
      .where(
        and(
          eq(oauthTokenGrants.id, oauthRefreshTokens.grantId),
          isNull(oauthTokenGrants.revokedAt),
          eq(oauthRefreshTokens.tokenHash, tokenHash),
          eq(oauthRefreshTokens.clientId, clientId),
          isNull(oauthRefreshTokens.revokedAt),
          gt(oauthRefreshTokens.expiresAt, now)
        )
      )
      .returning({
        id: oauthRefreshTokens.id,
        accessTokenId: oauthRefreshTokens.accessTokenId,
        grantId: oauthTokenGrants.id,
        grantClientId: oauthTokenGrants.clientId,
        grantUserId: oauthTokenGrants.userId,
        grantScopes: oauthTokenGrants.scopes,
        grantResource: oauthTokenGrants.resource,
      });

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
    const created = await insertTokenPair(tx, {
      id: claimed.grantId,
      clientId: claimed.grantClientId,
      userId: claimed.grantUserId,
      scopes: claimed.grantScopes,
      resource: claimed.grantResource,
    });

    // Only the previous release's reuse detection follows this link (#2053).
    await tx
      .update(oauthRefreshTokens)
      .set({ replacedById: created.refreshTokenId })
      .where(eq(oauthRefreshTokens.id, claimed.id));

    return created.tokens;
  });

  if (!tokens) {
    // The claim matched nothing: the token was unknown, expired, already
    // rotated, or its grant was revoked. A rotated token is either a genuine
    // reuse (leak) or a benign concurrent refresh racing the winner —
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
 * already revoked (but is otherwise valid and unexpired) while its grant is
 * still live, someone is replaying a rotated refresh token. Revoke the grant so
 * the chain is dead no matter which copy the replayer holds.
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
      grantId: oauthTokenGrants.id,
      grantRevokedAt: oauthTokenGrants.revokedAt,
    })
    .from(oauthRefreshTokens)
    .innerJoin(oauthTokenGrants, eq(oauthTokenGrants.id, oauthRefreshTokens.grantId))
    .where(
      and(eq(oauthRefreshTokens.tokenHash, tokenHash), eq(oauthRefreshTokens.clientId, clientId))
    )
    .limit(1);

  if (!presented || !presented.revokedAt || presented.expiresAt <= now) {
    // Unknown or merely expired token — not reuse, nothing to do
    return;
  }

  // The grant itself was revoked (a password change, a Connected Apps revoke,
  // an earlier reuse sweep): a client still presenting its token is out of
  // date, not evidence of a leak.
  if (presented.grantRevokedAt) {
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

  await revokeTokenGrants(eq(oauthTokenGrants.id, presented.grantId), db, now);

  logger.warn("OAuth refresh token reuse detected; revoked its grant", {
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
 * Either one revokes its whole grant (RFC 7009 §2.1: the server SHOULD
 * invalidate related tokens, and MAY revoke the refresh token behind an access
 * token).
 *
 * Only tokens belonging to `clientId` are revoked — a token owned by another
 * client is treated like an unknown token (a silent no-op), which is also what
 * the caller reports: RFC 7009 requires HTTP 200 for unknown tokens.
 */
export async function revokeClientToken(clientId: string, token: string): Promise<void> {
  const tokenHash = hashToken(token);

  await revokeTokenGrants(
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

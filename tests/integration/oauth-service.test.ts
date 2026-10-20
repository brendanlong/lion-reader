/**
 * Integration tests for OAuth 2.1 service single-use guarantees.
 *
 * See issue #951: authorization-code consumption was check-then-act (two
 * concurrent token requests could both redeem the same code, violating the
 * OAuth 2.1 single-use requirement), and refresh-token rotation had no
 * reuse detection. Both are now atomic UPDATE ... WHERE ... RETURNING claims.
 *
 * Replaying a rotated refresh token outside a short grace window revokes the
 * leaked token's grant (not every token for the user+client, which would sign
 * out unrelated devices sharing a client_id). Within the grace window the
 * replay is treated as benign concurrency (racing parallel refreshes) and the
 * live successor is left intact.
 */

import { describe, it, expect, afterAll } from "vitest";
import crypto from "crypto";
import { eq, inArray } from "drizzle-orm";
import { db } from "../../src/server/db";
import {
  users,
  oauthAccessTokens,
  oauthClients,
  oauthRefreshTokens,
  oauthTokenGrants,
} from "../../src/server/db/schema";
import { recordConsent, revokeUserClientTokens } from "../../src/server/oauth/grants";
import {
  createTestUser,
  createTestOAuthClient,
  createTestOAuthTokens,
  holdTransaction,
  waitForLockWaiter,
} from "./helpers";
import {
  createAuthorizationCode,
  exchangeAuthorizationCode,
  rotateRefreshToken,
  validateAccessToken,
  revokeClientToken,
} from "../../src/server/oauth/service";
import { getResourceIdentifier } from "../../src/server/oauth/config";
import { generateUuidv7 } from "../../src/lib/uuidv7";
import { hashToken, isOAuthAccessTokenFormat } from "../../src/server/oauth/utils";

/**
 * Backdate a refresh token's revocation so a subsequent replay falls outside the
 * rotation reuse grace window and is treated as a genuine leak rather than a
 * benign concurrent refresh.
 */
async function backdateRevocation(refreshTokenPlaintext: string): Promise<void> {
  await db
    .update(oauthRefreshTokens)
    .set({ revokedAt: new Date(Date.now() - 60_000) })
    .where(eq(oauthRefreshTokens.tokenHash, hashToken(refreshTokenPlaintext)));
}

const createdUserIds: string[] = [];
const createdClientIds: string[] = [];

const REDIRECT_URI = "https://example.com/callback";
const CODE_VERIFIER = "test-code-verifier-that-is-long-enough-for-rfc-7636";
const CODE_CHALLENGE = crypto
  .createHash("sha256")
  .update(CODE_VERIFIER, "ascii")
  .digest("base64url");

async function createUser(): Promise<string> {
  const userId = await createTestUser({
    emailPrefix: "oauth-service",
  });
  createdUserIds.push(userId);
  return userId;
}

async function createTestClient(): Promise<string> {
  const clientId = await createTestOAuthClient({ redirectUris: [REDIRECT_URI] });
  createdClientIds.push(clientId);
  return clientId;
}

async function createTestAuthCode(userId: string, clientId: string): Promise<string> {
  await recordConsent(userId, clientId, ["mcp"]);
  return createAuthorizationCode({
    clientId,
    userId,
    redirectUri: REDIRECT_URI,
    scopes: ["mcp"],
    codeChallenge: CODE_CHALLENGE,
  });
}

afterAll(async () => {
  // Cascades clean up codes/tokens via user FK
  if (createdUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
  if (createdClientIds.length > 0) {
    await db.delete(oauthClients).where(inArray(oauthClients.clientId, createdClientIds));
  }
});

describe("exchangeAuthorizationCode", () => {
  it("redeems a valid code exactly once", async () => {
    const userId = await createUser();
    const clientId = await createTestClient();
    const code = await createTestAuthCode(userId, clientId);

    const first = await exchangeAuthorizationCode(code, clientId, REDIRECT_URI, CODE_VERIFIER);
    expect(first).not.toBeNull();
    expect(first?.userId).toBe(userId);
    expect(first?.tokens.scope).toBe("mcp");
    expect(await validateAccessToken(first!.tokens.accessToken)).not.toBeNull();

    const second = await exchangeAuthorizationCode(code, clientId, REDIRECT_URI, CODE_VERIFIER);
    expect(second).toBeNull();
  });

  it("allows at most one of many concurrent redemptions to succeed", async () => {
    const userId = await createUser();
    const clientId = await createTestClient();
    const code = await createTestAuthCode(userId, clientId);

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        exchangeAuthorizationCode(code, clientId, REDIRECT_URI, CODE_VERIFIER)
      )
    );

    const successes = results.filter((r) => r !== null);
    expect(successes).toHaveLength(1);
  });

  it("burns the code when PKCE verification fails", async () => {
    const userId = await createUser();
    const clientId = await createTestClient();
    const code = await createTestAuthCode(userId, clientId);

    const bad = await exchangeAuthorizationCode(code, clientId, REDIRECT_URI, "wrong-verifier");
    expect(bad).toBeNull();

    // The failed attempt consumed the code; a later attempt with the correct
    // verifier must not succeed (an attacker can't retry verifiers).
    const retry = await exchangeAuthorizationCode(code, clientId, REDIRECT_URI, CODE_VERIFIER);
    expect(retry).toBeNull();
  });
});

describe("createTokens", () => {
  it("mints access tokens in the format request auth dispatches on", async () => {
    const tokens = await createTestOAuthTokens({
      clientId: await createTestClient(),
      userId: await createUser(),
      scopes: ["mcp"],
    });
    expect(isOAuthAccessTokenFormat(tokens.accessToken)).toBe(true);
  });

  it("refuses a grant without consent for any client but Wallabag", async () => {
    const userId = await createUser();
    await expect(
      db.insert(oauthTokenGrants).values({
        id: generateUuidv7(),
        userId,
        clientId: await createTestClient(),
        consentGrantId: null,
        scopes: ["mcp"],
      })
    ).rejects.toMatchObject({
      cause: { constraint: "oauth_token_grants_consent_unless_wallabag" },
    });
  });
});

describe("rotateRefreshToken", () => {
  it("rotates a valid refresh token and invalidates the old one", async () => {
    const userId = await createUser();
    const clientId = await createTestClient();
    const tokens = await createTestOAuthTokens({ clientId, userId, scopes: ["mcp"] });

    const rotated = await rotateRefreshToken(tokens.refreshToken, clientId);
    expect(rotated).not.toBeNull();
    expect(rotated?.refreshToken).not.toBe(tokens.refreshToken);

    // The old access token is revoked as part of rotation
    expect(await validateAccessToken(tokens.accessToken)).toBeNull();
  });

  it("allows at most one of many concurrent rotations to succeed", async () => {
    const userId = await createUser();
    const clientId = await createTestClient();
    const tokens = await createTestOAuthTokens({ clientId, userId, scopes: ["mcp"] });

    const results = await Promise.all(
      Array.from({ length: 5 }, () => rotateRefreshToken(tokens.refreshToken, clientId))
    );

    const successes = results.filter((r) => r !== null);
    expect(successes).toHaveLength(1);

    // The winner's tokens must survive the losing requests. The losers present
    // the just-revoked token, but that's benign concurrency (within the grace
    // window), not reuse — so it must not revoke the winner's fresh chain.
    const winner = successes[0]!;
    expect(await validateAccessToken(winner.accessToken)).not.toBeNull();
    expect(await rotateRefreshToken(winner.refreshToken, clientId)).not.toBeNull();
  });

  it("treats an immediate replay as benign concurrency and does not revoke the chain", async () => {
    const userId = await createUser();
    const clientId = await createTestClient();
    const tokens = await createTestOAuthTokens({ clientId, userId, scopes: ["mcp"] });

    const rotated = await rotateRefreshToken(tokens.refreshToken, clientId);
    expect(rotated).not.toBeNull();

    // An immediate replay (indistinguishable from a racing concurrent refresh)
    // is declined but must NOT trigger reuse revocation of the live successor.
    const replay = await rotateRefreshToken(tokens.refreshToken, clientId);
    expect(replay).toBeNull();

    expect(await validateAccessToken(rotated!.accessToken)).not.toBeNull();
    expect(await rotateRefreshToken(rotated!.refreshToken, clientId)).not.toBeNull();
  });

  it("revokes the whole grant when a rotated refresh token is replayed after the grace window", async () => {
    const userId = await createUser();
    const clientId = await createTestClient();
    const tokens = await createTestOAuthTokens({ clientId, userId, scopes: ["mcp"] });

    const rotated = await rotateRefreshToken(tokens.refreshToken, clientId);
    expect(rotated).not.toBeNull();
    expect(await validateAccessToken(rotated!.accessToken)).not.toBeNull();

    // Backdate the revocation so the replay looks like a genuine stale-token
    // leak (outside the concurrency grace window), not a racing refresh.
    await backdateRevocation(tokens.refreshToken);

    const replay = await rotateRefreshToken(tokens.refreshToken, clientId);
    expect(replay).toBeNull();

    // Reuse detection revoked the successor tokens too
    expect(await validateAccessToken(rotated!.accessToken)).toBeNull();
    expect(await rotateRefreshToken(rotated!.refreshToken, clientId)).toBeNull();
  });

  it("scopes reuse revocation to the leaked chain, sparing sibling grants for the same user+client", async () => {
    // Two independent grants for the same user+client — e.g. two Wallabag
    // devices, which all share client_id "wallabag". A reuse event on one must
    // not sign the other out.
    const userId = await createUser();
    const clientId = await createTestClient();
    const grantA = await createTestOAuthTokens({ clientId, userId, scopes: ["mcp"] });
    const grantB = await createTestOAuthTokens({ clientId, userId, scopes: ["mcp"] });

    // Rotate grant A once, then replay its original token after the grace window
    // so it registers as a genuine leak.
    const rotatedA = await rotateRefreshToken(grantA.refreshToken, clientId);
    expect(rotatedA).not.toBeNull();
    await backdateRevocation(grantA.refreshToken);
    const replay = await rotateRefreshToken(grantA.refreshToken, clientId);
    expect(replay).toBeNull();

    // Grant A's whole chain is dead...
    expect(await validateAccessToken(rotatedA!.accessToken)).toBeNull();
    expect(await rotateRefreshToken(rotatedA!.refreshToken, clientId)).toBeNull();

    // ...but the sibling grant B is untouched.
    expect(await validateAccessToken(grantB.accessToken)).not.toBeNull();
    expect(await rotateRefreshToken(grantB.refreshToken, clientId)).not.toBeNull();
  });

  it("waits out an uncommitted grant delete, then finds nothing to rotate", async () => {
    const userId = await createUser();
    const clientId = await createTestClient();
    const tokens = await createTestOAuthTokens({ clientId, userId, scopes: ["mcp"] });

    const held = await holdTransaction((tx) =>
      tx.delete(oauthTokenGrants).where(eq(oauthTokenGrants.userId, userId))
    );
    const rotation = rotateRefreshToken(tokens.refreshToken, clientId);
    await waitForLockWaiter("%oauth_token_grants%for key share%");
    await held.commit();

    expect(await rotation).toBeNull();
  });

  it("takes a token committed into the grant while its delete waited", async () => {
    // What a rotation's successor relies on: the cascade sees rows committed
    // after the DELETE started waiting on the grant.
    const userId = await createUser();
    const clientId = await createTestClient();
    await createTestOAuthTokens({ clientId, userId, scopes: ["mcp"] });
    const [{ grantId }] = await db
      .select({ grantId: oauthTokenGrants.id })
      .from(oauthTokenGrants)
      .where(eq(oauthTokenGrants.userId, userId));

    const lateId = generateUuidv7();
    const held = await holdTransaction((tx) =>
      tx.insert(oauthAccessTokens).values({
        id: lateId,
        grantId,
        tokenHash: `late-${lateId}`,
        clientId,
        userId,
        expiresAt: new Date(Date.now() + 3_600_000),
      })
    );
    const revoke = revokeUserClientTokens(userId, clientId);
    await waitForLockWaiter('%delete from "oauth_token_grants"%');
    await held.commit();
    await revoke;

    const rows = await db
      .select({ id: oauthAccessTokens.id })
      .from(oauthAccessTokens)
      .where(eq(oauthAccessTokens.id, lateId));
    expect(rows).toEqual([]);
  });

  it("serializes with retention deleting its access token instead of deadlocking (#2069)", async () => {
    const userId = await createUser();
    const clientId = await createTestClient();
    const tokens = await createTestOAuthTokens({ clientId, userId, scopes: ["mcp"] });
    const accessTokenHash = hashToken(tokens.accessToken);

    // Retention's DELETE locks the access token, then its cascade updates the
    // refresh row at the end of the statement; pause between the two.
    let resume!: () => void;
    const paused = new Promise<void>((resolve) => (resume = resolve));
    let locked!: () => void;
    const accessTokenLocked = new Promise<void>((resolve) => (locked = resolve));
    const retention = db.transaction(async (tx) => {
      await tx
        .select({ id: oauthAccessTokens.id })
        .from(oauthAccessTokens)
        .where(eq(oauthAccessTokens.tokenHash, accessTokenHash))
        .for("update");
      locked();
      await paused;
      await tx.delete(oauthAccessTokens).where(eq(oauthAccessTokens.tokenHash, accessTokenHash));
    });
    await accessTokenLocked;

    const rotation = rotateRefreshToken(tokens.refreshToken, clientId);
    await waitForLockWaiter("%oauth_access_tokens%");
    resume();

    await retention;
    expect(await rotation).not.toBeNull();
  });

  it("leaves nothing usable when a revocation races rotations", async () => {
    const userId = await createUser();
    const clientId = await createTestClient();
    const tokens = await createTestOAuthTokens({ clientId, userId, scopes: ["mcp"] });

    const [rotated] = await Promise.all([
      rotateRefreshToken(tokens.refreshToken, clientId),
      revokeUserClientTokens(userId, clientId),
    ]);

    if (rotated) {
      expect(await validateAccessToken(rotated.accessToken)).toBeNull();
      expect(await rotateRefreshToken(rotated.refreshToken, clientId)).toBeNull();
    }
    expect(await validateAccessToken(tokens.accessToken)).toBeNull();
  });

  it("does not revoke the grant for an unknown refresh token", async () => {
    const userId = await createUser();
    const clientId = await createTestClient();
    const tokens = await createTestOAuthTokens({ clientId, userId, scopes: ["mcp"] });

    const bogus = await rotateRefreshToken("completely-unknown-token", clientId);
    expect(bogus).toBeNull();

    // The real grant is untouched
    expect(await validateAccessToken(tokens.accessToken)).not.toBeNull();
    expect(await rotateRefreshToken(tokens.refreshToken, clientId)).not.toBeNull();
  });

  // Rotation preserves the grant's own resource. Blanket-stamping the canonical MCP identifier onto every rotated token would
  // mislabel a Wallabag credential (minted with a null resource) as MCP-audienced.
  describe("resource/audience preservation", () => {
    it("keeps a null resource null (does not stamp the MCP audience)", async () => {
      const userId = await createUser();
      const clientId = await createTestClient();
      // Wallabag mints with no resource.
      const tokens = await createTestOAuthTokens({
        clientId,
        userId,
        scopes: ["reader:full-access"],
      });

      const rotated = await rotateRefreshToken(tokens.refreshToken, clientId);
      expect(rotated).not.toBeNull();

      const validated = await validateAccessToken(rotated!.accessToken);
      expect(validated?.resource).toBeNull();
    });

    it("preserves the canonical MCP audience across rotation", async () => {
      const userId = await createUser();
      const clientId = await createTestClient();
      const tokens = await createTestOAuthTokens({
        clientId,
        userId,
        scopes: ["mcp"],
        resource: getResourceIdentifier(),
      });

      const rotated = await rotateRefreshToken(tokens.refreshToken, clientId);
      expect(rotated).not.toBeNull();

      const validated = await validateAccessToken(rotated!.accessToken);
      expect(validated?.resource).toBe(getResourceIdentifier());
    });
  });
});

describe("revokeClientToken (RFC 7009)", () => {
  it.each(["accessToken", "refreshToken"] as const)(
    "revokes the whole grant given any %s in it, even a rotated-out one",
    async (presented) => {
      const userId = await createUser();
      const clientId = await createTestClient();
      const first = await createTestOAuthTokens({ clientId, userId, scopes: ["mcp"] });
      const current = (await rotateRefreshToken(first.refreshToken, clientId))!;

      await revokeClientToken(clientId, first[presented]);

      expect(await validateAccessToken(current.accessToken)).toBeNull();
      expect(await rotateRefreshToken(current.refreshToken, clientId)).toBeNull();
    }
  );

  it("is a silent no-op for an unknown token", async () => {
    const clientId = await createTestClient();
    await expect(revokeClientToken(clientId, "not-a-real-token")).resolves.toBeUndefined();
  });

  it("does not revoke a token owned by a different client", async () => {
    const userId = await createUser();
    const clientId = await createTestClient();
    const otherClientId = await createTestClient();
    const tokens = await createTestOAuthTokens({ clientId, userId, scopes: ["mcp"] });

    await revokeClientToken(otherClientId, tokens.accessToken);
    await revokeClientToken(otherClientId, tokens.refreshToken);

    expect(await validateAccessToken(tokens.accessToken)).not.toBeNull();
  });
});

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
import { eq, inArray, sql } from "drizzle-orm";
import { db } from "../../src/server/db";
import {
  users,
  oauthAccessTokens,
  oauthClients,
  oauthRefreshTokens,
  oauthTokenGrants,
} from "../../src/server/db/schema";
import { revokeUserClientTokens } from "../../src/server/oauth/grants";
import { createTestUser, createTestOAuthClient } from "./helpers";
import {
  createAuthorizationCode,
  validateAndConsumeAuthCode,
  createTokens,
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

describe("validateAndConsumeAuthCode", () => {
  it("redeems a valid code exactly once", async () => {
    const userId = await createUser();
    const clientId = await createTestClient();
    const code = await createTestAuthCode(userId, clientId);

    const first = await validateAndConsumeAuthCode(code, clientId, REDIRECT_URI, CODE_VERIFIER);
    expect(first).not.toBeNull();
    expect(first?.userId).toBe(userId);
    expect(first?.scopes).toEqual(["mcp"]);

    const second = await validateAndConsumeAuthCode(code, clientId, REDIRECT_URI, CODE_VERIFIER);
    expect(second).toBeNull();
  });

  it("allows at most one of many concurrent redemptions to succeed", async () => {
    const userId = await createUser();
    const clientId = await createTestClient();
    const code = await createTestAuthCode(userId, clientId);

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        validateAndConsumeAuthCode(code, clientId, REDIRECT_URI, CODE_VERIFIER)
      )
    );

    const successes = results.filter((r) => r !== null);
    expect(successes).toHaveLength(1);
  });

  it("burns the code when PKCE verification fails", async () => {
    const userId = await createUser();
    const clientId = await createTestClient();
    const code = await createTestAuthCode(userId, clientId);

    const bad = await validateAndConsumeAuthCode(code, clientId, REDIRECT_URI, "wrong-verifier");
    expect(bad).toBeNull();

    // The failed attempt consumed the code; a later attempt with the correct
    // verifier must not succeed (an attacker can't retry verifiers).
    const retry = await validateAndConsumeAuthCode(code, clientId, REDIRECT_URI, CODE_VERIFIER);
    expect(retry).toBeNull();
  });
});

describe("createTokens", () => {
  it("mints access tokens in the format request auth dispatches on", async () => {
    const tokens = await createTokens({
      clientId: await createTestClient(),
      userId: await createUser(),
      scopes: ["mcp"],
    });
    expect(isOAuthAccessTokenFormat(tokens.accessToken)).toBe(true);
  });
});

describe("rotateRefreshToken", () => {
  it("rotates a valid refresh token and invalidates the old one", async () => {
    const userId = await createUser();
    const clientId = await createTestClient();
    const tokens = await createTokens({ clientId, userId, scopes: ["mcp"] });

    const rotated = await rotateRefreshToken(tokens.refreshToken, clientId);
    expect(rotated).not.toBeNull();
    expect(rotated?.refreshToken).not.toBe(tokens.refreshToken);

    // The old access token is revoked as part of rotation
    expect(await validateAccessToken(tokens.accessToken)).toBeNull();
  });

  it("allows at most one of many concurrent rotations to succeed", async () => {
    const userId = await createUser();
    const clientId = await createTestClient();
    const tokens = await createTokens({ clientId, userId, scopes: ["mcp"] });

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
    const tokens = await createTokens({ clientId, userId, scopes: ["mcp"] });

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
    const tokens = await createTokens({ clientId, userId, scopes: ["mcp"] });

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
    const grantA = await createTokens({ clientId, userId, scopes: ["mcp"] });
    const grantB = await createTokens({ clientId, userId, scopes: ["mcp"] });

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

  it("refuses a token whose grant was revoked, even if the token row wasn't", async () => {
    // The state a rotation racing a revocation leaves behind: its successor
    // committed after the sweep, into the grant the sweep revoked.
    const userId = await createUser();
    const clientId = await createTestClient();
    const tokens = await createTokens({ clientId, userId, scopes: ["mcp"] });
    await db
      .update(oauthTokenGrants)
      .set({ revokedAt: new Date() })
      .where(eq(oauthTokenGrants.userId, userId));

    expect(await validateAccessToken(tokens.accessToken)).toBeNull();
    expect(await rotateRefreshToken(tokens.refreshToken, clientId)).toBeNull();
  });

  it("leaves nothing usable when a revocation races rotations", async () => {
    const userId = await createUser();
    const clientId = await createTestClient();
    const tokens = await createTokens({ clientId, userId, scopes: ["mcp"] });

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
    const tokens = await createTokens({ clientId, userId, scopes: ["mcp"] });

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
      const tokens = await createTokens({ clientId, userId, scopes: ["reader:full-access"] });

      const rotated = await rotateRefreshToken(tokens.refreshToken, clientId);
      expect(rotated).not.toBeNull();

      const validated = await validateAccessToken(rotated!.accessToken);
      expect(validated?.resource).toBeNull();
    });

    it("preserves the canonical MCP audience across rotation", async () => {
      const userId = await createUser();
      const clientId = await createTestClient();
      const tokens = await createTokens({
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
    "revokes the whole grant given its %s",
    async (presented) => {
      const userId = await createUser();
      const clientId = await createTestClient();
      const first = await createTokens({ clientId, userId, scopes: ["mcp"] });
      const current = (await rotateRefreshToken(first.refreshToken, clientId))!;

      await revokeClientToken(clientId, current[presented]);

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
    const tokens = await createTokens({ clientId, userId, scopes: ["mcp"] });

    await revokeClientToken(otherClientId, tokens.accessToken);
    await revokeClientToken(otherClientId, tokens.refreshToken);

    expect(await validateAccessToken(tokens.accessToken)).not.toBeNull();
  });
});

/**
 * The previous release, still serving during a rollout, writes tokens without
 * a grant and links rotations only through replaced_by_id. Its rows must land
 * in a grant, or revoking grants would miss them.
 */
describe("tokens written by the previous release", () => {
  async function insertLegacyPair(userId: string, clientId: string) {
    const accessId = generateUuidv7();
    const refreshId = generateUuidv7();
    const expiresAt = new Date(Date.now() + 3_600_000);
    await db.execute(sql`
      INSERT INTO oauth_access_tokens (id, token_hash, client_id, user_id, scopes, expires_at)
      VALUES (${accessId}, ${"legacy-" + accessId}, ${clientId}, ${userId}, ARRAY['mcp'], ${expiresAt})
    `);
    await db.execute(sql`
      INSERT INTO oauth_refresh_tokens
        (id, token_hash, client_id, user_id, scopes, access_token_id, expires_at)
      VALUES (${refreshId}, ${"legacy-" + refreshId}, ${clientId}, ${userId}, ARRAY['mcp'],
        ${accessId}, ${expiresAt})
    `);
    return { accessId, refreshId };
  }

  async function grantsOf(ids: string[]): Promise<Set<string>> {
    const [access, refresh] = await Promise.all([
      db
        .select({ grantId: oauthAccessTokens.grantId })
        .from(oauthAccessTokens)
        .where(inArray(oauthAccessTokens.id, ids)),
      db
        .select({ grantId: oauthRefreshTokens.grantId })
        .from(oauthRefreshTokens)
        .where(inArray(oauthRefreshTokens.id, ids)),
    ]);
    return new Set([...access, ...refresh].map((row) => row.grantId));
  }

  it("puts a new pair in one grant, and a rotation's successor in its predecessor's", async () => {
    const userId = await createUser();
    const clientId = await createTestClient();
    const first = await insertLegacyPair(userId, clientId);
    const second = await insertLegacyPair(userId, clientId);
    await db.execute(sql`
      UPDATE oauth_refresh_tokens SET replaced_by_id = ${second.refreshId}
      WHERE id = ${first.refreshId}
    `);

    const grants = await grantsOf([
      first.accessId,
      first.refreshId,
      second.accessId,
      second.refreshId,
    ]);
    expect(grants.size).toBe(1);

    const [grant] = await db
      .select()
      .from(oauthTokenGrants)
      .where(eq(oauthTokenGrants.id, [...grants][0]));
    expect(grant).toMatchObject({ userId, clientId, scopes: ["mcp"], revokedAt: null });
  });
});

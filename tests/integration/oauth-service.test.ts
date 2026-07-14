/**
 * Integration tests for OAuth 2.1 service single-use guarantees.
 *
 * See issue #951: authorization-code consumption was check-then-act (two
 * concurrent token requests could both redeem the same code, violating the
 * OAuth 2.1 single-use requirement), and refresh-token rotation had no
 * reuse detection. Both are now atomic UPDATE ... WHERE ... RETURNING claims.
 *
 * Replaying a rotated refresh token outside a short grace window revokes the
 * leaked token's rotation chain (not every token for the user+client, which
 * would sign out unrelated devices sharing a client_id). Within the grace window
 * the replay is treated as benign concurrency (racing parallel refreshes) and
 * the live successor is left intact.
 */

import { describe, it, expect, afterAll } from "vitest";
import crypto from "crypto";
import { eq, inArray } from "drizzle-orm";
import { db } from "../../src/server/db";
import { users, oauthClients, oauthRefreshTokens } from "../../src/server/db/schema";
import { generateUuidv7 } from "../../src/lib/uuidv7";
import {
  createAuthorizationCode,
  validateAndConsumeAuthCode,
  createTokens,
  rotateRefreshToken,
  validateAccessToken,
  revokeClientToken,
} from "../../src/server/oauth/service";
import { getIssuer, getResourceIdentifier } from "../../src/server/oauth/config";
import { hashToken } from "../../src/server/oauth/utils";

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

async function createTestUser(): Promise<string> {
  const userId = generateUuidv7();
  await db.insert(users).values({
    id: userId,
    email: `oauth-service-${userId}@test.com`,
    passwordHash: "test-hash",
    tosAgreedAt: new Date(),
    privacyPolicyAgreedAt: new Date(),
    notEuAgreedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  createdUserIds.push(userId);
  return userId;
}

async function createTestClient(): Promise<string> {
  const clientId = generateUuidv7();
  await db.insert(oauthClients).values({
    id: generateUuidv7(),
    clientId,
    name: "Test Client",
    redirectUris: [REDIRECT_URI],
    scopes: ["mcp"],
    isPublic: true,
  });
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
    const userId = await createTestUser();
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
    const userId = await createTestUser();
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
    const userId = await createTestUser();
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

describe("rotateRefreshToken", () => {
  it("rotates a valid refresh token and invalidates the old one", async () => {
    const userId = await createTestUser();
    const clientId = await createTestClient();
    const tokens = await createTokens({ clientId, userId, scopes: ["mcp"] });

    const rotated = await rotateRefreshToken(tokens.refreshToken, clientId);
    expect(rotated).not.toBeNull();
    expect(rotated?.refreshToken).not.toBe(tokens.refreshToken);

    // The old access token is revoked as part of rotation
    expect(await validateAccessToken(tokens.accessToken)).toBeNull();
  });

  it("allows at most one of many concurrent rotations to succeed", async () => {
    const userId = await createTestUser();
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
    const userId = await createTestUser();
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
    const userId = await createTestUser();
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
    const userId = await createTestUser();
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

  it("does not revoke the grant for an unknown refresh token", async () => {
    const userId = await createTestUser();
    const clientId = await createTestClient();
    const tokens = await createTokens({ clientId, userId, scopes: ["mcp"] });

    const bogus = await rotateRefreshToken("completely-unknown-token", clientId);
    expect(bogus).toBeNull();

    // The real grant is untouched
    expect(await validateAccessToken(tokens.accessToken)).not.toBeNull();
    expect(await rotateRefreshToken(tokens.refreshToken, clientId)).not.toBeNull();
  });

  // Audience re-binding on rotation preserves the grant's own resource and
  // migrates only the legacy bare-origin audience to the canonical identifier.
  // Blanket-stamping the canonical MCP identifier onto every rotated token would
  // mislabel a Wallabag credential (minted with a null resource) as MCP-audienced.
  describe("resource/audience preservation", () => {
    it("keeps a null resource null (does not stamp the MCP audience)", async () => {
      const userId = await createTestUser();
      const clientId = await createTestClient();
      // Wallabag mints with no resource.
      const tokens = await createTokens({ clientId, userId, scopes: ["reader:full-access"] });

      const rotated = await rotateRefreshToken(tokens.refreshToken, clientId);
      expect(rotated).not.toBeNull();

      const validated = await validateAccessToken(rotated!.accessToken);
      expect(validated?.resource).toBeNull();
    });

    it("migrates the legacy bare-origin audience to the canonical identifier", async () => {
      const userId = await createTestUser();
      const clientId = await createTestClient();
      const tokens = await createTokens({
        clientId,
        userId,
        scopes: ["mcp"],
        resource: getIssuer(),
      });

      const rotated = await rotateRefreshToken(tokens.refreshToken, clientId);
      expect(rotated).not.toBeNull();

      const validated = await validateAccessToken(rotated!.accessToken);
      expect(validated?.resource).toBe(getResourceIdentifier());
    });

    it("preserves the canonical MCP audience across rotation", async () => {
      const userId = await createTestUser();
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
  it("revokes an access token", async () => {
    const userId = await createTestUser();
    const clientId = await createTestClient();
    const tokens = await createTokens({ clientId, userId, scopes: ["mcp"] });

    await revokeClientToken(clientId, tokens.accessToken);
    expect(await validateAccessToken(tokens.accessToken)).toBeNull();

    // The refresh token stays usable — RFC 7009 only requires revoking related
    // refresh tokens when the client also revokes them; rotation still works.
    expect(await rotateRefreshToken(tokens.refreshToken, clientId)).not.toBeNull();
  });

  it("revokes a refresh token and its linked access token", async () => {
    const userId = await createTestUser();
    const clientId = await createTestClient();
    const tokens = await createTokens({ clientId, userId, scopes: ["mcp"] });

    await revokeClientToken(clientId, tokens.refreshToken);

    // RFC 7009 §2.1: revoking a refresh token SHOULD invalidate the access
    // token issued with it.
    expect(await validateAccessToken(tokens.accessToken)).toBeNull();
    expect(await rotateRefreshToken(tokens.refreshToken, clientId)).toBeNull();
  });

  it("is a silent no-op for an unknown token", async () => {
    const clientId = await createTestClient();
    await expect(revokeClientToken(clientId, "not-a-real-token")).resolves.toBeUndefined();
  });

  it("does not revoke a token owned by a different client", async () => {
    const userId = await createTestUser();
    const clientId = await createTestClient();
    const otherClientId = await createTestClient();
    const tokens = await createTokens({ clientId, userId, scopes: ["mcp"] });

    await revokeClientToken(otherClientId, tokens.accessToken);
    await revokeClientToken(otherClientId, tokens.refreshToken);

    expect(await validateAccessToken(tokens.accessToken)).not.toBeNull();
  });
});

/**
 * Integration tests for the user-facing OAuth grant management surface
 * (`oauthGrants.list` / `oauthGrants.revoke`, issue #1520).
 *
 * The consent screen promises revocation in Settings, and revocation has to
 * mean both halves: the consent grant goes away (so the client can't get a
 * silent authorization code), and the outstanding tokens die (so the client
 * can't keep using — or refreshing — what it already holds).
 */

import { describe, it, expect, afterAll } from "vitest";
import crypto from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { db } from "../../src/server/db";
import {
  users,
  oauthClients,
  oauthAccessTokens,
  oauthConsentGrants,
} from "../../src/server/db/schema";
import {
  createTestUser,
  createTestOAuthClient,
  createAuthContext,
  createTestOAuthTokens,
  holdTransaction,
  waitForLockWaiter,
} from "./helpers";
import { createCaller } from "../../src/server/trpc/root";
import { recordConsent } from "../../src/server/oauth/grants";
import {
  createAuthorizationCode,
  rotateRefreshToken,
  validateAccessToken,
  exchangeAuthorizationCode,
} from "../../src/server/oauth/service";
import { hashToken, isLoopbackUrl, LAST_USED_REFRESH_MS } from "../../src/server/oauth/utils";
import { APP_CLIENT_ID } from "../../src/server/oauth/app-client";
import { PINNED_CLIENT_METADATA } from "../../src/server/oauth/cimd";

const createdUserIds: string[] = [];
const createdClientIds: string[] = [];

const REDIRECT_URI = "https://example.com/callback";
const CODE_VERIFIER = "test-code-verifier-that-is-long-enough-for-rfc-7636";
const CODE_CHALLENGE = crypto
  .createHash("sha256")
  .update(CODE_VERIFIER, "ascii")
  .digest("base64url");

async function createUser(): Promise<string> {
  const userId = await createTestUser({ emailPrefix: "oauth-grants" });
  createdUserIds.push(userId);
  return userId;
}

/** A registered (DCR) client — the case where we have a name of our own. */
async function createRegisteredClient(name: string): Promise<string> {
  const clientId = await createTestOAuthClient({ name });
  createdClientIds.push(clientId);
  return clientId;
}

async function hasConsentGrant(userId: string, clientId: string): Promise<boolean> {
  const rows = await db
    .select({ id: oauthConsentGrants.id })
    .from(oauthConsentGrants)
    .where(and(eq(oauthConsentGrants.userId, userId), eq(oauthConsentGrants.clientId, clientId)));
  return rows.length > 0;
}

async function callerFor(userId: string) {
  return createCaller(await createAuthContext(userId));
}

afterAll(async () => {
  if (createdUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
  if (createdClientIds.length > 0) {
    await db.delete(oauthClients).where(inArray(oauthClients.clientId, createdClientIds));
  }
});

describe("oauthGrants.list", () => {
  it("returns registered clients by name with their scope descriptions", async () => {
    const userId = await createUser();
    const clientId = await createRegisteredClient("Test MCP Client");
    await recordConsent(userId, clientId, ["mcp"]);

    const caller = await callerFor(userId);
    const grants = await caller.oauthGrants.list();

    expect(grants).toHaveLength(1);
    expect(grants[0].clientId).toBe(clientId);
    expect(grants[0].clientName).toBe("Test MCP Client");
    expect(grants[0].clientHost).toBeNull();
    expect(grants[0].scopes).toEqual([
      { name: "mcp", description: "Read and manage your feeds and articles" },
    ]);
    expect(grants[0].grantedAt).toBeInstanceOf(Date);
  });

  it("identifies a CIMD client by its client_id hostname, with no name", async () => {
    const userId = await createUser();
    const clientId = "https://claude.ai/api/mcp/client-metadata.json";
    await recordConsent(userId, clientId, ["mcp"]);

    const caller = await callerFor(userId);
    const grants = await caller.oauthGrants.list();

    expect(grants).toHaveLength(1);
    expect(grants[0].clientName).toBeNull();
    expect(grants[0].clientHost).toBe("claude.ai");
    expect(grants[0]).toMatchObject({
      redirectHosts: [],
      redirectsToLocalApp: false,
      unverified: true,
    });
  });

  it("lists every host a registered client can send codes to, and marks it unverified", async () => {
    const userId = await createUser();
    const clientId = await createTestOAuthClient({
      name: "Claude",
      redirectUris: [
        "https://attacker.example/cb",
        "https://attacker.example/other",
        "http://localhost/cb",
      ],
    });
    createdClientIds.push(clientId);
    await recordConsent(userId, clientId, ["mcp"]);

    const [grant] = await (await callerFor(userId)).oauthGrants.list();
    expect(grant.redirectHosts).toEqual(["attacker.example"]);
    expect(grant.redirectsToLocalApp).toBe(true);
    expect(grant.unverified).toBe(true);
  });

  it("treats our app and vendored clients off loopback as verified, and loopback ones not", async () => {
    const userId = await createUser();
    const pinned = [...PINNED_CLIENT_METADATA.values()];
    const remote = pinned.find((m) => !m.redirect_uris.some(isLoopbackUrl));
    const local = pinned.find((m) => m.redirect_uris.every(isLoopbackUrl));
    if (!remote || !local) throw new Error("expected a remote and a loopback vendored client");
    for (const clientId of [APP_CLIENT_ID, remote.client_id, local.client_id]) {
      await recordConsent(userId, clientId, ["mcp"]);
    }

    const grants = new Map(
      (await (await callerFor(userId)).oauthGrants.list()).map((g) => [g.clientId, g])
    );
    expect(grants.get(APP_CLIENT_ID)).toMatchObject({ unverified: false, redirectHosts: [] });
    expect(grants.get(remote.client_id)).toMatchObject({
      unverified: false,
      redirectHosts: [...new Set(remote.redirect_uris.map((uri) => new URL(uri).hostname))],
      redirectsToLocalApp: false,
    });
    expect(grants.get(local.client_id)).toMatchObject({
      unverified: true,
      redirectHosts: [],
      redirectsToLocalApp: true,
    });
  });

  it("reports the most recent access-token use", async () => {
    const userId = await createUser();
    const clientId = await createRegisteredClient("Used Client");
    await recordConsent(userId, clientId, ["mcp"]);
    const { accessToken } = await createTestOAuthTokens({ clientId, userId, scopes: ["mcp"] });

    const caller = await callerFor(userId);
    expect((await caller.oauthGrants.list())[0].lastUsedAt).toBeNull();

    await validateAccessToken(accessToken);
    // validateAccessToken records last_used_at fire-and-forget.
    await waitForLastUsedAt(accessToken);

    expect((await caller.oauthGrants.list())[0].lastUsedAt).toBeInstanceOf(Date);
  });

  it("rewrites last_used_at only once it's stale", async () => {
    // The app presents its token on every request, so a write per use would be
    // a write per speech chunk.
    const userId = await createUser();
    const clientId = await createRegisteredClient("Busy Client");
    const { accessToken } = await createTestOAuthTokens({ clientId, userId, scopes: ["mcp"] });
    const tokenRow = eq(oauthAccessTokens.tokenHash, hashToken(accessToken));
    const lastUsedAt = async () =>
      (
        await db
          .select({ at: oauthAccessTokens.lastUsedAt })
          .from(oauthAccessTokens)
          .where(tokenRow)
      )[0].at;

    const fresh = new Date(Date.now() - (LAST_USED_REFRESH_MS - 5_000));
    await db.update(oauthAccessTokens).set({ lastUsedAt: fresh }).where(tokenRow);
    await validateAccessToken(accessToken);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await lastUsedAt()).toEqual(fresh);

    const stale = new Date(Date.now() - (LAST_USED_REFRESH_MS + 5_000));
    await db.update(oauthAccessTokens).set({ lastUsedAt: stale }).where(tokenRow);
    await validateAccessToken(accessToken);
    await expect.poll(lastUsedAt).not.toEqual(stale);
  });

  it("does not leak another user's grants", async () => {
    const userId = await createUser();
    const otherUserId = await createUser();
    const clientId = await createRegisteredClient("Other User's Client");
    await recordConsent(otherUserId, clientId, ["mcp"]);

    const caller = await callerFor(userId);
    expect(await caller.oauthGrants.list()).toEqual([]);
  });

  it("omits revoked grants", async () => {
    const userId = await createUser();
    const clientId = await createRegisteredClient("Revoked Client");
    await recordConsent(userId, clientId, ["mcp"]);

    const caller = await callerFor(userId);
    await caller.oauthGrants.revoke({ clientId });

    expect(await caller.oauthGrants.list()).toEqual([]);
  });
});

describe("oauthGrants.revoke", () => {
  it("drops the consent and kills the client's access and refresh tokens", async () => {
    const userId = await createUser();
    const clientId = await createRegisteredClient("Revocable Client");
    await recordConsent(userId, clientId, ["mcp"]);
    const { accessToken, refreshToken } = await createTestOAuthTokens({
      clientId,
      userId,
      scopes: ["mcp"],
    });

    const caller = await callerFor(userId);
    await caller.oauthGrants.revoke({ clientId });

    expect(await hasConsentGrant(userId, clientId)).toBe(false);
    expect(await validateAccessToken(accessToken)).toBeNull();
    expect(await rotateRefreshToken(refreshToken, clientId)).toBeNull();
  });

  it("leaves other clients' grants and tokens alone", async () => {
    const userId = await createUser();
    const revokedClientId = await createRegisteredClient("Revoked Client");
    const keptClientId = await createRegisteredClient("Kept Client");
    await recordConsent(userId, revokedClientId, ["mcp"]);
    await recordConsent(userId, keptClientId, ["mcp"]);
    const kept = await createTestOAuthTokens({ clientId: keptClientId, userId, scopes: ["mcp"] });

    const caller = await callerFor(userId);
    await caller.oauthGrants.revoke({ clientId: revokedClientId });

    expect(await hasConsentGrant(userId, keptClientId)).toBe(true);
    expect(await validateAccessToken(kept.accessToken)).not.toBeNull();
  });

  it("cannot revoke another user's grant for the same client", async () => {
    const userId = await createUser();
    const otherUserId = await createUser();
    const clientId = await createRegisteredClient("Shared Client");
    await recordConsent(otherUserId, clientId, ["mcp"]);
    const otherTokens = await createTestOAuthTokens({
      clientId,
      userId: otherUserId,
      scopes: ["mcp"],
    });

    const caller = await callerFor(userId);
    await expect(caller.oauthGrants.revoke({ clientId })).rejects.toThrow(TRPCError);

    expect(await hasConsentGrant(otherUserId, clientId)).toBe(true);
    expect(await validateAccessToken(otherTokens.accessToken)).not.toBeNull();
  });

  it("rejects revoking a client the user never authorized", async () => {
    const userId = await createUser();
    const clientId = await createRegisteredClient("Unauthorized Client");

    const caller = await callerFor(userId);
    await expect(caller.oauthGrants.revoke({ clientId })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

describe("oauthGrants.revoke closes the paths back in", () => {
  it("kills an authorization code the client hasn't redeemed yet", async () => {
    // A code minted moments before the user clicks Revoke would otherwise stay
    // redeemable for its full 10-minute life and buy a fresh access token plus a
    // 30-day refresh chain — silently undoing the revocation.
    const userId = await createUser();
    const clientId = await createRegisteredClient("Client With A Pending Code");
    await recordConsent(userId, clientId, ["mcp"]);
    const code = await createAuthorizationCode({
      clientId,
      userId,
      redirectUri: REDIRECT_URI,
      scopes: ["mcp"],
      codeChallenge: CODE_CHALLENGE,
    });

    const caller = await callerFor(userId);
    await caller.oauthGrants.revoke({ clientId });

    expect(await exchangeAuthorizationCode(code, clientId, REDIRECT_URI, CODE_VERIFIER)).toBeNull();
  });

  it("refuses a code issued after the revoke", async () => {
    // /oauth/authorize checked consent, then issued its code only after the
    // revoke had already burned the outstanding ones.
    const userId = await createUser();
    const clientId = await createRegisteredClient("Client Issuing Late");
    await recordConsent(userId, clientId, ["mcp"]);
    const caller = await callerFor(userId);
    await caller.oauthGrants.revoke({ clientId });

    const code = await createAuthorizationCode({
      clientId,
      userId,
      redirectUri: REDIRECT_URI,
      scopes: ["mcp"],
      codeChallenge: CODE_CHALLENGE,
    });
    expect(await exchangeAuthorizationCode(code, clientId, REDIRECT_URI, CODE_VERIFIER)).toBeNull();
  });

  it("refuses a code exchange that waited on an uncommitted revoke", async () => {
    const userId = await createUser();
    const clientId = await createRegisteredClient("Client Waiting On A Revoke");
    await recordConsent(userId, clientId, ["mcp"]);
    const code = await createAuthorizationCode({
      clientId,
      userId,
      redirectUri: REDIRECT_URI,
      scopes: ["mcp"],
      codeChallenge: CODE_CHALLENGE,
    });

    const held = await holdTransaction((tx) =>
      tx.delete(oauthConsentGrants).where(eq(oauthConsentGrants.userId, userId))
    );
    const exchange = exchangeAuthorizationCode(code, clientId, REDIRECT_URI, CODE_VERIFIER);
    await waitForLockWaiter('%insert into "oauth_token_grants"%');
    await held.commit();

    expect(await exchange).toBeNull();
  });

  it("leaves nothing usable when the revoke races a code exchange", async () => {
    const userId = await createUser();
    const clientId = await createRegisteredClient("Client Racing A Revoke");
    await recordConsent(userId, clientId, ["mcp"]);
    const code = await createAuthorizationCode({
      clientId,
      userId,
      redirectUri: REDIRECT_URI,
      scopes: ["mcp"],
      codeChallenge: CODE_CHALLENGE,
    });

    const caller = await callerFor(userId);
    const [exchange] = await Promise.all([
      exchangeAuthorizationCode(code, clientId, REDIRECT_URI, CODE_VERIFIER),
      caller.oauthGrants.revoke({ clientId }),
    ]);

    if (exchange) {
      expect(await validateAccessToken(exchange.tokens.accessToken)).toBeNull();
      expect(await rotateRefreshToken(exchange.tokens.refreshToken, clientId)).toBeNull();
    }
  });
});

/**
 * `validateAccessToken` updates `last_used_at` without awaiting it, so poll
 * until the write lands rather than racing it.
 */
async function waitForLastUsedAt(accessToken: string): Promise<void> {
  const tokenHash = hashToken(accessToken);
  for (let attempt = 0; attempt < 50; attempt++) {
    const [row] = await db
      .select({ lastUsedAt: oauthAccessTokens.lastUsedAt })
      .from(oauthAccessTokens)
      .where(eq(oauthAccessTokens.tokenHash, tokenHash))
      .limit(1);
    if (row?.lastUsedAt) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("last_used_at was never recorded");
}

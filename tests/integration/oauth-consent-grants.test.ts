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
import { eq, inArray } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { db } from "../../src/server/db";
import { users, oauthClients, oauthAccessTokens } from "../../src/server/db/schema";
import { generateUuidv7 } from "../../src/lib/uuidv7";
import { createTestUser, createAuthContext } from "./helpers";
import { createCaller } from "../../src/server/trpc/root";
import {
  createTokens,
  hasConsent,
  recordConsent,
  rotateRefreshToken,
  validateAccessToken,
} from "../../src/server/oauth/service";
import { hashToken } from "../../src/server/oauth/utils";

const createdUserIds: string[] = [];
const createdClientIds: string[] = [];

async function createUser(): Promise<string> {
  const userId = await createTestUser({ emailPrefix: "oauth-grants" });
  createdUserIds.push(userId);
  return userId;
}

/** A registered (DCR) client — the case where we have a name of our own. */
async function createRegisteredClient(name: string): Promise<string> {
  const clientId = generateUuidv7();
  await db.insert(oauthClients).values({
    id: generateUuidv7(),
    clientId,
    name,
    redirectUris: ["https://example.com/callback"],
    scopes: ["mcp"],
    isPublic: true,
  });
  createdClientIds.push(clientId);
  return clientId;
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
  });

  it("reports the most recent access-token use", async () => {
    const userId = await createUser();
    const clientId = await createRegisteredClient("Used Client");
    await recordConsent(userId, clientId, ["mcp"]);
    const { accessToken } = await createTokens({ clientId, userId, scopes: ["mcp"] });

    const caller = await callerFor(userId);
    expect((await caller.oauthGrants.list())[0].lastUsedAt).toBeNull();

    await validateAccessToken(accessToken);
    // validateAccessToken records last_used_at fire-and-forget.
    await waitForLastUsedAt(accessToken);

    expect((await caller.oauthGrants.list())[0].lastUsedAt).toBeInstanceOf(Date);
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
    const { accessToken, refreshToken } = await createTokens({
      clientId,
      userId,
      scopes: ["mcp"],
    });

    const caller = await callerFor(userId);
    await caller.oauthGrants.revoke({ clientId });

    expect(await hasConsent(userId, clientId, ["mcp"])).toBe(false);
    expect(await validateAccessToken(accessToken)).toBeNull();
    expect(await rotateRefreshToken(refreshToken, clientId)).toBeNull();
  });

  it("leaves other clients' grants and tokens alone", async () => {
    const userId = await createUser();
    const revokedClientId = await createRegisteredClient("Revoked Client");
    const keptClientId = await createRegisteredClient("Kept Client");
    await recordConsent(userId, revokedClientId, ["mcp"]);
    await recordConsent(userId, keptClientId, ["mcp"]);
    const kept = await createTokens({ clientId: keptClientId, userId, scopes: ["mcp"] });

    const caller = await callerFor(userId);
    await caller.oauthGrants.revoke({ clientId: revokedClientId });

    expect(await hasConsent(userId, keptClientId, ["mcp"])).toBe(true);
    expect(await validateAccessToken(kept.accessToken)).not.toBeNull();
  });

  it("cannot revoke another user's grant for the same client", async () => {
    const userId = await createUser();
    const otherUserId = await createUser();
    const clientId = await createRegisteredClient("Shared Client");
    await recordConsent(otherUserId, clientId, ["mcp"]);
    const otherTokens = await createTokens({ clientId, userId: otherUserId, scopes: ["mcp"] });

    const caller = await callerFor(userId);
    await expect(caller.oauthGrants.revoke({ clientId })).rejects.toThrow(TRPCError);

    expect(await hasConsent(otherUserId, clientId, ["mcp"])).toBe(true);
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

/**
 * Authentication of `/api/mcp`: which credentials the endpoint takes, through
 * the real route handler.
 */

import { describe, it, expect, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { eq, inArray } from "drizzle-orm";
import { db } from "../../src/server/db";
import { apiTokens, oauthAccessTokens, oauthClients, users } from "../../src/server/db/schema";
import { POST } from "../../src/app/api/mcp/route";
import { createApiToken } from "../../src/server/auth/api-token";
import { createTokens } from "../../src/server/oauth/service";
import { getResourceIdentifier } from "../../src/server/oauth/config";
import { hashToken } from "../../src/server/oauth/utils";
import { createTestOAuthClient, createTestUnprefixedAccessToken, createTestUser } from "./helpers";

const createdUserIds: string[] = [];
const createdClientIds: string[] = [];

afterAll(async () => {
  if (createdUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
  if (createdClientIds.length > 0) {
    await db.delete(oauthClients).where(inArray(oauthClients.clientId, createdClientIds));
  }
});

async function createUserAndClient(): Promise<{ userId: string; clientId: string }> {
  const userId = await createTestUser({ emailPrefix: "mcp-auth" });
  createdUserIds.push(userId);
  const clientId = await createTestOAuthClient();
  createdClientIds.push(clientId);
  return { userId, clientId };
}

/** An MCP `initialize` call; succeeds with any credential the endpoint accepts. */
function initialize(token: string): Promise<Response> {
  return POST(
    new NextRequest("http://localhost:3000/api/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "test", version: "1.0.0" },
        },
      }),
    })
  );
}

type TokenKind = "API token" | "OAuth token" | "OAuth token without the prefix";

async function mcpToken(kind: TokenKind): Promise<string> {
  const { userId, clientId } = await createUserAndClient();
  const oauth = { clientId, userId, scopes: ["mcp"], resource: getResourceIdentifier() };
  switch (kind) {
    case "API token":
      return (await createApiToken(userId, ["mcp"])).token;
    case "OAuth token":
      return (await createTokens(oauth)).accessToken;
    case "OAuth token without the prefix":
      return createTestUnprefixedAccessToken(oauth);
  }
}

describe("/api/mcp authentication", () => {
  it.each<TokenKind>(["API token", "OAuth token", "OAuth token without the prefix"])(
    "accepts an mcp-scoped %s",
    async (kind) => {
      expect((await initialize(await mcpToken(kind))).status).toBe(200);
    }
  );

  it("rejects a revoked API token and a revoked OAuth token", async () => {
    const apiToken = await mcpToken("API token");
    await db
      .update(apiTokens)
      .set({ revokedAt: new Date() })
      .where(eq(apiTokens.tokenHash, hashToken(apiToken)));
    expect((await initialize(apiToken)).status).toBe(401);

    const oauthToken = await mcpToken("OAuth token");
    await db
      .update(oauthAccessTokens)
      .set({ revokedAt: new Date() })
      .where(eq(oauthAccessTokens.tokenHash, hashToken(oauthToken)));
    expect((await initialize(oauthToken)).status).toBe(401);
  });
});

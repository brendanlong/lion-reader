/**
 * Integration tests for OAuth client authentication at the token and
 * revocation endpoints (authenticateClient): a confidential client's 401
 * invalid_client carries `WWW-Authenticate: Basic` exactly when the client
 * authenticated with HTTP Basic (RFC 6749 §5.2).
 */

import { describe, it, expect, afterAll } from "vitest";
import { inArray } from "drizzle-orm";
import { db } from "../../src/server/db";
import { oauthClients } from "../../src/server/db/schema";
import { authenticateClient } from "../../src/server/oauth/client-auth";
import { hashToken } from "../../src/server/oauth/utils";
import { createTestOAuthClient } from "./helpers";

const createdClientIds: string[] = [];

afterAll(async () => {
  await db.delete(oauthClients).where(inArray(oauthClients.clientId, createdClientIds));
});

async function confidentialClient(secret: string): Promise<string> {
  const clientId = await createTestOAuthClient({
    isPublic: false,
    clientSecretHash: hashToken(secret),
  });
  createdClientIds.push(clientId);
  return clientId;
}

function basicHeader(clientId: string, clientSecret: string): string {
  const encoded = `${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`;
  return `Basic ${Buffer.from(encoded, "utf-8").toString("base64")}`;
}

function tokenRequest(authorization?: string): Request {
  return new Request("https://example.com/oauth/token", {
    method: "POST",
    headers: authorization ? { authorization } : {},
  });
}

describe("authenticateClient", () => {
  it("authenticates a confidential client by Basic header or body", async () => {
    const clientId = await confidentialClient("right");

    const viaBasic = await authenticateClient(tokenRequest(basicHeader(clientId, "right")), {});
    expect(viaBasic).toMatchObject({ clientId });
    const viaBody = await authenticateClient(tokenRequest(), {
      client_id: clientId,
      client_secret: "right",
    });
    expect(viaBody).toMatchObject({ clientId });
  });

  it.each([
    ["a wrong secret", async () => basicHeader(await confidentialClient("right"), "wrong")],
    ["an unknown client", async () => basicHeader("no-such-client", "secret")],
  ])("names the Basic scheme on a 401 for %s sent by Basic", async (_name, header) => {
    const result = await authenticateClient(tokenRequest(await header()), {});
    if (!(result instanceof Response)) throw new Error("expected an error response");
    expect(result.status).toBe(401);
    expect(await result.json()).toMatchObject({ error: "invalid_client" });
    expect(result.headers.get("www-authenticate")).toMatch(/^Basic /);
  });

  it("sends no WWW-Authenticate when the credentials came in the body", async () => {
    const clientId = await confidentialClient("right");
    const result = await authenticateClient(tokenRequest(), {
      client_id: clientId,
      client_secret: "wrong",
    });
    if (!(result instanceof Response)) throw new Error("expected an error response");
    expect(result.status).toBe(401);
    expect(result.headers.get("www-authenticate")).toBeNull();
  });
});

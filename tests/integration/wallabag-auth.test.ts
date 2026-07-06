/**
 * Integration tests for Wallabag API authentication + scope enforcement.
 *
 * The Wallabag surface exposes the full reader API (list/read/mutate/delete
 * entries + tags), so it mints and requires the `reader:full-access` OAuth
 * scope. A token that authenticates but lacks that scope (e.g. a `saved:write`
 * save-only credential, or an `mcp` token) must be rejected with 403 — this is
 * what stops a narrow scope from being replayed for full library access.
 *
 * See issue #1022.
 */

import { describe, it, expect, afterAll } from "vitest";
import * as argon2 from "argon2";
import { inArray } from "drizzle-orm";
import { db } from "../../src/server/db";
import { users } from "../../src/server/db/schema";
import { generateUuidv7 } from "../../src/lib/uuidv7";
import { createTokens, validateAccessToken } from "../../src/server/oauth/service";
import { requireAuth, passwordGrant } from "../../src/server/wallabag/auth";
import { OAUTH_SCOPES } from "../../src/server/oauth/utils";

const createdUserIds: string[] = [];

async function createTestUser(password?: string): Promise<{ id: string; email: string }> {
  const id = generateUuidv7();
  const email = `wallabag-${id}@test.com`;
  await db.insert(users).values({
    id,
    email,
    passwordHash: password ? await argon2.hash(password) : "test-hash",
    tosAgreedAt: new Date(),
    privacyPolicyAgreedAt: new Date(),
    notEuAgreedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  createdUserIds.push(id);
  return { id, email };
}

async function mintToken(userId: string, scopes: string[]): Promise<string> {
  const tokens = await createTokens({ clientId: "wallabag", userId, scopes });
  return tokens.accessToken;
}

function bearerRequest(token: string | null): Request {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  return new Request("https://example.com/api/wallabag/api/user", { headers });
}

afterAll(async () => {
  if (createdUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
});

describe("Wallabag requireAuth scope enforcement", () => {
  it("accepts a reader:full-access token", async () => {
    const user = await createTestUser();
    const token = await mintToken(user.id, [OAUTH_SCOPES.READER_FULL_ACCESS]);

    const result = await requireAuth(bearerRequest(token));

    expect(result).not.toBeInstanceOf(Response);
    if (result instanceof Response) throw new Error("unreachable");
    expect(result.userId).toBe(user.id);
    expect(result.email).toBe(user.email);
  });

  it("rejects a saved:write-only token with 403 insufficient_scope", async () => {
    const user = await createTestUser();
    const token = await mintToken(user.id, [OAUTH_SCOPES.SAVED_WRITE]);

    const result = await requireAuth(bearerRequest(token));

    expect(result).toBeInstanceOf(Response);
    if (!(result instanceof Response)) throw new Error("unreachable");
    expect(result.status).toBe(403);
    expect(await result.json()).toMatchObject({ error: "insufficient_scope" });
  });

  it("rejects an mcp-scoped token with 403 (audience/scope confinement)", async () => {
    const user = await createTestUser();
    const token = await mintToken(user.id, [OAUTH_SCOPES.MCP]);

    const result = await requireAuth(bearerRequest(token));

    expect(result).toBeInstanceOf(Response);
    if (!(result instanceof Response)) throw new Error("unreachable");
    expect(result.status).toBe(403);
  });

  it("returns 401 for a missing token", async () => {
    const result = await requireAuth(bearerRequest(null));
    expect(result).toBeInstanceOf(Response);
    if (!(result instanceof Response)) throw new Error("unreachable");
    expect(result.status).toBe(401);
  });

  it("returns 401 for an invalid token", async () => {
    const result = await requireAuth(bearerRequest("not-a-real-token"));
    expect(result).toBeInstanceOf(Response);
    if (!(result instanceof Response)) throw new Error("unreachable");
    expect(result.status).toBe(401);
  });
});

describe("Wallabag passwordGrant", () => {
  it("mints a reader:full-access token that requireAuth accepts", async () => {
    const password = "correct-horse-battery-staple";
    const user = await createTestUser(password);

    const grant = await passwordGrant(user.email, password, "wallabag");
    expect(grant).not.toBeNull();
    if (!grant) throw new Error("unreachable");

    // The minted access token carries reader:full-access...
    const tokenData = await validateAccessToken(grant.access_token);
    expect(tokenData?.scopes).toContain(OAUTH_SCOPES.READER_FULL_ACCESS);

    // ...and is accepted by requireAuth.
    const result = await requireAuth(bearerRequest(grant.access_token));
    expect(result).not.toBeInstanceOf(Response);
  });

  it("returns null for a wrong password", async () => {
    const user = await createTestUser("the-right-password");
    const grant = await passwordGrant(user.email, "the-wrong-password", "wallabag");
    expect(grant).toBeNull();
  });
});

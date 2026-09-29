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

import { describe, it, expect, afterAll, vi } from "vitest";
import * as argon2 from "argon2";
import { eq, inArray, sql } from "drizzle-orm";
import { db } from "../../src/server/db";
import { oauthRefreshTokens, users } from "../../src/server/db/schema";
import { generateUuidv7 } from "../../src/lib/uuidv7";
import {
  createTokens,
  revokeUserClientTokens,
  rotateRefreshToken,
  validateAccessToken,
} from "../../src/server/oauth/service";
import { requireAuth, passwordGrant, WALLABAG_CLIENT_ID } from "../../src/server/wallabag/auth";
import { OAUTH_SCOPES } from "../../src/server/oauth/utils";
import { POST as tokenEndpoint } from "../../src/app/api/wallabag/oauth/v2/token/route";
import { createCaller } from "../../src/server/trpc/root";
import { createAuthContext, createTestUser } from "./helpers";

const createdUserIds: string[] = [];

/**
 * A confirmed user. Pass `password` when the test signs in through the password
 * grant, which needs a hash it can actually verify.
 */
async function createUser(password?: string): Promise<{ id: string; email: string }> {
  const id = generateUuidv7();
  const email = `wallabag-${id}@test.com`;
  await createTestUser({
    id,
    email,
    passwordHash: password ? await argon2.hash(password) : "test-hash",
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
    const user = await createUser();
    const token = await mintToken(user.id, [OAUTH_SCOPES.READER_FULL_ACCESS]);

    const result = await requireAuth(bearerRequest(token));

    expect(result).not.toBeInstanceOf(Response);
    if (result instanceof Response) throw new Error("unreachable");
    expect(result.userId).toBe(user.id);
    expect(result.email).toBe(user.email);
  });

  it("rejects a saved:write-only token with 403 insufficient_scope", async () => {
    const user = await createUser();
    const token = await mintToken(user.id, [OAUTH_SCOPES.SAVED_WRITE]);

    const result = await requireAuth(bearerRequest(token));

    expect(result).toBeInstanceOf(Response);
    if (!(result instanceof Response)) throw new Error("unreachable");
    expect(result.status).toBe(403);
    expect(await result.json()).toMatchObject({ error: "insufficient_scope" });
  });

  it("rejects an mcp-scoped token with 403 (audience/scope confinement)", async () => {
    const user = await createUser();
    const token = await mintToken(user.id, [OAUTH_SCOPES.MCP]);

    const result = await requireAuth(bearerRequest(token));

    expect(result).toBeInstanceOf(Response);
    if (!(result instanceof Response)) throw new Error("unreachable");
    expect(result.status).toBe(403);
  });

  it("rejects a reader:full-access token for an unconfirmed user with 403", async () => {
    const id = generateUuidv7();
    const email = `wallabag-unconfirmed-${id}@test.com`;
    await db.insert(users).values({
      id,
      email,
      passwordHash: "test-hash",
      // No tos/privacy/EU agreement — signup not confirmed.
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    createdUserIds.push(id);

    const token = await mintToken(id, [OAUTH_SCOPES.READER_FULL_ACCESS]);
    const result = await requireAuth(bearerRequest(token));

    expect(result).toBeInstanceOf(Response);
    if (!(result instanceof Response)) throw new Error("unreachable");
    expect(result.status).toBe(403);
    expect(await result.json()).toMatchObject({ error: "access_denied" });
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
    const user = await createUser(password);

    const grant = await passwordGrant(user.email, password);
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
    const user = await createUser("the-right-password");
    const grant = await passwordGrant(user.email, "the-wrong-password");
    expect(grant).toBeNull();
  });
});

/**
 * A form POST to the token endpoint from a fresh client IP, so the strict
 * per-IP bucket never throttles one test on behalf of another.
 */
function tokenRequest(params: Record<string, string>): Request {
  const ip = `10.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}`;
  return new Request("https://example.com/api/wallabag/oauth/v2/token", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "fly-client-ip": ip,
    },
    body: new URLSearchParams(params).toString(),
  });
}

describe("Wallabag token endpoint client_id pinning", () => {
  const password = "correct-horse-battery-staple";

  it("accepts client_id=wallabag and mints tokens under the wallabag client", async () => {
    const user = await createUser(password);

    const response = await tokenEndpoint(
      tokenRequest({
        grant_type: "password",
        client_id: "wallabag",
        client_secret: "wallabag",
        username: user.email,
        password,
      })
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { access_token: string; refresh_token: string };
    expect((await validateAccessToken(body.access_token))?.clientId).toBe(WALLABAG_CLIENT_ID);
  });

  it("accepts a request with no client_id", async () => {
    const user = await createUser(password);

    const response = await tokenEndpoint(
      tokenRequest({ grant_type: "password", username: user.email, password })
    );

    expect(response.status).toBe(200);
  });

  it("rejects a password grant under another client_id with invalid_client", async () => {
    const user = await createUser(password);

    const response = await tokenEndpoint(
      tokenRequest({
        grant_type: "password",
        client_id: "some-mcp-client",
        username: user.email,
        password,
      })
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: "invalid_client" });
  });

  it("refuses to rotate another client's refresh token", async () => {
    // The attack: a stolen MCP refresh token presented here with its own
    // client_id would otherwise be rotated with no client secret and no consent
    // re-check.
    const user = await createUser();
    const victimClientId = "confidential-mcp-client";
    const victim = await createTokens({
      clientId: victimClientId,
      userId: user.id,
      scopes: [OAUTH_SCOPES.MCP],
    });

    const response = await tokenEndpoint(
      tokenRequest({
        grant_type: "refresh_token",
        client_id: victimClientId,
        refresh_token: victim.refreshToken,
      })
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: "invalid_client" });

    // Omitting client_id pins to the wallabag client, which doesn't own it.
    const pinned = await tokenEndpoint(
      tokenRequest({ grant_type: "refresh_token", refresh_token: victim.refreshToken })
    );
    expect(pinned.status).toBe(401);

    // The victim's chain is untouched.
    expect(await validateAccessToken(victim.accessToken)).not.toBeNull();
    expect(await rotateRefreshToken(victim.refreshToken, victimClientId)).not.toBeNull();
  });

  it("rotates a wallabag refresh token", async () => {
    const user = await createUser();
    const tokens = await createTokens({
      clientId: WALLABAG_CLIENT_ID,
      userId: user.id,
      scopes: [OAUTH_SCOPES.READER_FULL_ACCESS],
    });

    const response = await tokenEndpoint(
      tokenRequest({
        grant_type: "refresh_token",
        client_id: "wallabag",
        client_secret: "wallabag",
        refresh_token: tokens.refreshToken,
      })
    );

    expect(response.status).toBe(200);
  });
});

describe("oauthGrants.revokeWallabag", () => {
  it("signs out the caller's Wallabag apps only", async () => {
    const user = await createUser();
    const bystander = await createUser();
    const mine = await createTokens({
      clientId: WALLABAG_CLIENT_ID,
      userId: user.id,
      scopes: [OAUTH_SCOPES.READER_FULL_ACCESS],
    });
    const mcp = await createTokens({
      clientId: "some-mcp-client",
      userId: user.id,
      scopes: [OAUTH_SCOPES.MCP],
    });
    const theirs = await createTokens({
      clientId: WALLABAG_CLIENT_ID,
      userId: bystander.id,
      scopes: [OAUTH_SCOPES.READER_FULL_ACCESS],
    });

    const caller = createCaller(await createAuthContext(user.id));
    await expect(caller.oauthGrants.revokeWallabag()).resolves.toEqual({ success: true });

    expect(await validateAccessToken(mine.accessToken)).toBeNull();
    expect(await rotateRefreshToken(mine.refreshToken, WALLABAG_CLIENT_ID)).toBeNull();
    expect(await validateAccessToken(mcp.accessToken)).not.toBeNull();
    expect(await validateAccessToken(theirs.accessToken)).not.toBeNull();
  });
});

/**
 * Resolves once a token issue is blocked on the user-row share lock
 * (`lockUserAgainstCredentialChange`), not on some unrelated lock.
 */
async function waitForUserLockWaiter(): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = await db.execute(sql`
      SELECT count(*)::int AS waiting FROM pg_stat_activity
      WHERE datname = current_database()
        AND wait_event_type = 'Lock'
        AND query ILIKE '%from "users"%for share%'
    `);
    if ((result.rows[0] as { waiting: number }).waiting > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("nothing ever waited on the lock");
}

/**
 * Runs a password change the way `me.changePassword` does — update the user
 * row, then sweep its Wallabag tokens, in one transaction — but holds the
 * transaction open between the two until `release` is called, so a concurrent
 * token issue can be started inside the window.
 */
async function heldPasswordChange(
  userId: string,
  newHash: string
): Promise<{ release: () => void; done: Promise<void> }> {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let updated!: () => void;
  const rowUpdated = new Promise<void>((resolve) => (updated = resolve));
  const done = db.transaction(async (tx) => {
    await tx
      .update(users)
      .set({ passwordHash: newHash, updatedAt: new Date() })
      .where(eq(users.id, userId));
    updated();
    await gate;
    await revokeUserClientTokens(userId, WALLABAG_CLIENT_ID, tx);
  });
  await rowUpdated;
  return { release, done };
}

/** Access or refresh tokens for the Wallabag client that would still work. */
async function liveWallabagTokens(userId: string): Promise<number> {
  const result = await db.execute(sql`
    SELECT
      (SELECT count(*) FROM oauth_access_tokens
        WHERE user_id = ${userId} AND client_id = ${WALLABAG_CLIENT_ID}
          AND revoked_at IS NULL AND expires_at > now())
      + (SELECT count(*) FROM oauth_refresh_tokens
        WHERE user_id = ${userId} AND client_id = ${WALLABAG_CLIENT_ID}
          AND revoked_at IS NULL AND expires_at > now())
      AS live
  `);
  return Number((result.rows[0] as { live: string | number }).live);
}

describe("token issue racing a password change", () => {
  it("a refresh during a password change waits for it, then finds its token revoked", async () => {
    const user = await createUser();
    const tokens = await createTokens({
      clientId: WALLABAG_CLIENT_ID,
      userId: user.id,
      scopes: [OAUTH_SCOPES.READER_FULL_ACCESS],
    });

    const change = await heldPasswordChange(user.id, await argon2.hash("new-password"));
    const rotation = rotateRefreshToken(tokens.refreshToken, WALLABAG_CLIENT_ID);
    await waitForUserLockWaiter();
    change.release();
    await change.done;

    expect(await rotation).toBeNull();
    expect(await liveWallabagTokens(user.id)).toBe(0);
  });

  it("a password grant racing a password change mints nothing", async () => {
    const password = "the-old-password";
    const user = await createUser(password);

    // The grant verifies the old password (still committed) before the change
    // commits, then must notice the change under the lock.
    const change = await heldPasswordChange(user.id, await argon2.hash("new-password"));
    const grant = passwordGrant(user.email, password);
    await waitForUserLockWaiter();
    change.release();
    await change.done;

    expect(await grant).toBeNull();
    expect(await liveWallabagTokens(user.id)).toBe(0);
  });
});

describe("refresh token revoked without rotation", () => {
  it("is refused without a reuse-detection alarm", async () => {
    const user = await createUser();
    const tokens = await createTokens({
      clientId: WALLABAG_CLIENT_ID,
      userId: user.id,
      scopes: [OAUTH_SCOPES.READER_FULL_ACCESS],
    });
    // Revoked by a password change a minute ago, well outside the grace window.
    await db
      .update(oauthRefreshTokens)
      .set({ revokedAt: new Date(Date.now() - 60_000) })
      .where(eq(oauthRefreshTokens.userId, user.id));

    const warn = vi.spyOn(console, "warn");
    try {
      expect(await rotateRefreshToken(tokens.refreshToken, WALLABAG_CLIENT_ID)).toBeNull();
      const logged = warn.mock.calls.map((args) => String(args[0]));
      expect(logged.some((line) => line.includes("reuse detected"))).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });
});

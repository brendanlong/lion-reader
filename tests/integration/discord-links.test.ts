/**
 * Integration tests for the Discord bot's API-token account links.
 *
 * These links live in Postgres (`discord_api_token_links`) so they survive the
 * deploy-time Redis cache clear (#1370). They store a reference to the
 * api_tokens row, so a revoked/expired/deleted token must resolve to null.
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/server/db";
import { users, apiTokens, discordApiTokenLinks } from "../../src/server/db/schema";
import { generateUuidv7 } from "../../src/lib/uuidv7";
import { createApiToken } from "../../src/server/auth/api-token";
import {
  linkDiscordApiToken,
  resolveDiscordUser,
  unlinkDiscordApiToken,
} from "../../src/server/services/discord-links";
import { createTestOAuthLink, createTestUser } from "./helpers";

// Discord snowflakes are numeric strings; make them unique per test.
function makeDiscordId(): string {
  return generateUuidv7().replace(/\D/g, "").slice(0, 18) || "1";
}

const createdUserIds: string[] = [];

async function createUser(overrides: Parameters<typeof createTestUser>[0] = {}): Promise<string> {
  const userId = await createTestUser({ emailPrefix: "discord-link", ...overrides });
  createdUserIds.push(userId);
  return userId;
}

afterAll(async () => {
  // Cascades clean up api_tokens + discord_api_token_links.
  for (const userId of createdUserIds) {
    await db.delete(users).where(eq(users.id, userId));
  }
});

describe("Discord API-token links", () => {
  let userId: string;
  let tokenId: string;
  let discordId: string;

  beforeEach(async () => {
    userId = await createUser();
    ({ id: tokenId } = await createApiToken(userId, ["saved:write"], "Discord"));
    discordId = makeDiscordId();
  });

  it("links and resolves a Discord user to the token's owner", async () => {
    await linkDiscordApiToken(db, discordId, tokenId);
    expect(await resolveDiscordUser(db, discordId)).toEqual({
      userId,
      method: "token",
      confirmed: true,
    });
  });

  it("returns null for an unlinked Discord user", async () => {
    expect(await resolveDiscordUser(db, makeDiscordId())).toBeNull();
  });

  it("upserts: re-linking replaces the previous token", async () => {
    await linkDiscordApiToken(db, discordId, tokenId);

    const { id: newTokenId } = await createApiToken(userId, ["saved:write"], "Discord 2");
    await linkDiscordApiToken(db, discordId, newTokenId);

    const rows = await db
      .select()
      .from(discordApiTokenLinks)
      .where(eq(discordApiTokenLinks.discordId, discordId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tokenId).toBe(newTokenId);
    expect((await resolveDiscordUser(db, discordId))?.userId).toBe(userId);
  });

  it("resolves to null when the linked token is revoked", async () => {
    await linkDiscordApiToken(db, discordId, tokenId);
    await db.update(apiTokens).set({ revokedAt: new Date() }).where(eq(apiTokens.id, tokenId));

    expect(await resolveDiscordUser(db, discordId)).toBeNull();
    // The link row itself is left in place (only the token state changed).
    const rows = await db
      .select()
      .from(discordApiTokenLinks)
      .where(eq(discordApiTokenLinks.discordId, discordId));
    expect(rows).toHaveLength(1);
  });

  it("resolves to null when the linked token is expired", async () => {
    await linkDiscordApiToken(db, discordId, tokenId);
    await db
      .update(apiTokens)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(apiTokens.id, tokenId));

    expect(await resolveDiscordUser(db, discordId)).toBeNull();
  });

  it("still resolves a token with a future expiry", async () => {
    const { id: futureTokenId } = await createApiToken(
      userId,
      ["saved:write"],
      "Future",
      new Date(Date.now() + 60_000)
    );
    await linkDiscordApiToken(db, discordId, futureTokenId);
    expect((await resolveDiscordUser(db, discordId))?.userId).toBe(userId);
  });

  it("cascade-deletes the link when the token row is deleted", async () => {
    await linkDiscordApiToken(db, discordId, tokenId);
    await db.delete(apiTokens).where(eq(apiTokens.id, tokenId));

    const rows = await db
      .select()
      .from(discordApiTokenLinks)
      .where(eq(discordApiTokenLinks.discordId, discordId));
    expect(rows).toHaveLength(0);
    expect(await resolveDiscordUser(db, discordId)).toBeNull();
  });

  it("unlink returns true when a link existed and removes it", async () => {
    await linkDiscordApiToken(db, discordId, tokenId);
    expect(await unlinkDiscordApiToken(db, discordId)).toBe(true);
    expect(await resolveDiscordUser(db, discordId)).toBeNull();
  });

  it("unlink returns false when no link existed", async () => {
    expect(await unlinkDiscordApiToken(db, makeDiscordId())).toBe(false);
  });
});

describe("resolveDiscordUser", () => {
  it("prefers the OAuth link over an API-token link", async () => {
    const oauthUserId = await createUser();
    const tokenUserId = await createUser();
    const discordId = makeDiscordId();
    await createTestOAuthLink(oauthUserId, "discord", { providerAccountId: discordId });
    const { id: tokenId } = await createApiToken(tokenUserId, ["saved:write"], "Discord");
    await linkDiscordApiToken(db, discordId, tokenId);

    expect(await resolveDiscordUser(db, discordId)).toEqual({
      userId: oauthUserId,
      method: "oauth",
      confirmed: true,
    });
  });

  // An abandoned "Sign in with Discord" must not shadow a later /link to a real
  // account.
  it("prefers a confirmed API-token link over an unconfirmed OAuth link", async () => {
    const oauthUserId = await createUser({ tosAgreedAt: null, privacyPolicyAgreedAt: null });
    const tokenUserId = await createUser();
    const discordId = makeDiscordId();
    await createTestOAuthLink(oauthUserId, "discord", { providerAccountId: discordId });
    const { id: tokenId } = await createApiToken(tokenUserId, ["saved:write"], "Discord");
    await linkDiscordApiToken(db, discordId, tokenId);

    expect(await resolveDiscordUser(db, discordId)).toEqual({
      userId: tokenUserId,
      method: "token",
      confirmed: true,
    });
  });

  // A first Discord sign-in creates the account before its owner accepts the
  // Terms; the bot must not save for it (SECURITY.md §8).
  it.each(["oauth", "token"] as const)(
    "reports a %s-linked user who hasn't finished signup as unconfirmed",
    async (method) => {
      const userId = await createUser({ tosAgreedAt: null, privacyPolicyAgreedAt: null });
      const discordId = makeDiscordId();
      if (method === "oauth") {
        await createTestOAuthLink(userId, "discord", { providerAccountId: discordId });
      } else {
        const { id: tokenId } = await createApiToken(userId, ["saved:write"], "Discord");
        await linkDiscordApiToken(db, discordId, tokenId);
      }

      expect(await resolveDiscordUser(db, discordId)).toEqual({
        userId,
        method,
        confirmed: false,
      });
    }
  );
});

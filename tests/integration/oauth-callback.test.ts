/**
 * Integration tests for the shared OAuth callback processor.
 *
 * Focused on the email-verification gate: OAuth sign-in is the only way an email
 * becomes verified in this app, so an unverified provider email must never be
 * trusted to link into — or create — an account (account-takeover defense).
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { eq, and, sql } from "drizzle-orm";
import { db } from "../../src/server/db";
import {
  users,
  sessions,
  oauthAccounts,
  apiTokens,
  oauthAuthorizationCodes,
  oauthConsentGrants,
  oauthTokenGrants,
} from "../../src/server/db/schema";
import { generateUuidv7 } from "../../src/lib/uuidv7";
import { processOAuthCallback } from "../../src/server/auth/oauth/callback";
import { createSession } from "../../src/server/auth/session";
import { createApiToken } from "../../src/server/auth/api-token";
import { createAuthorizationCode } from "../../src/server/oauth/service";
import { WALLABAG_CLIENT_ID } from "../../src/server/wallabag/client";
import { createTestOAuthLink, createTestTokenGrant, createTestUser, deleteUsers } from "./helpers";

const VICTIM_EMAIL = "victim@example.com";

async function countOAuthAccounts(userId: string): Promise<number> {
  const rows = await db.select().from(oauthAccounts).where(eq(oauthAccounts.userId, userId));
  return rows.length;
}

describe("processOAuthCallback email verification", () => {
  async function cleanup(): Promise<void> {
    await db.delete(sessions);
    await db.delete(oauthAccounts);
    await deleteUsers();
  }

  beforeEach(cleanup);
  afterAll(cleanup);

  it("refuses to link an unverified provider email to an existing account", async () => {
    const victimId = await createTestUser({ email: VICTIM_EMAIL });

    await expect(
      processOAuthCallback({
        provider: "google",
        providerAccountId: "attacker-google-id",
        email: VICTIM_EMAIL,
        emailVerified: false,
        accessToken: "access-token",
      })
    ).rejects.toThrow(/not verified/i);

    // No OAuth account should have been linked to the victim.
    expect(await countOAuthAccounts(victimId)).toBe(0);
  });

  it("refuses to create a new user from an unverified provider email", async () => {
    await expect(
      processOAuthCallback({
        provider: "google",
        providerAccountId: "new-google-id",
        email: "brand-new@example.com",
        emailVerified: false,
        accessToken: "access-token",
      })
    ).rejects.toThrow(/not verified/i);

    const rows = await db.select().from(users).where(eq(users.email, "brand-new@example.com"));
    expect(rows.length).toBe(0);
  });

  it("logs in a returning user by provider account id regardless of emailVerified", async () => {
    // Apple stops sending email/verification on subsequent sign-ins; a returning
    // user matched by providerAccountId must still work with emailVerified=false.
    const userId = await createTestUser({ email: "returning@example.com" });
    await db.insert(oauthAccounts).values({
      id: generateUuidv7(),
      userId,
      provider: "apple",
      providerAccountId: "returning-apple-id",
      accessToken: "old-token",
      createdAt: new Date(),
    });

    const result = await processOAuthCallback({
      provider: "apple",
      providerAccountId: "returning-apple-id",
      email: undefined,
      emailVerified: false,
      accessToken: "new-token",
    });

    expect(result.signupConfirmed).toBe(true);
    expect(result.userId).toBe(userId);
    // Existing link count unchanged (no new row).
    expect(
      (
        await db
          .select()
          .from(oauthAccounts)
          .where(
            and(
              eq(oauthAccounts.provider, "apple"),
              eq(oauthAccounts.providerAccountId, "returning-apple-id")
            )
          )
      ).length
    ).toBe(1);
  });

  it("keeps the stored refresh token when a returning sign-in sends none (#1803)", async () => {
    const userId = await createTestUser({ email: "returning@example.com" });
    await db.insert(oauthAccounts).values({
      id: generateUuidv7(),
      userId,
      provider: "google",
      providerAccountId: "returning-google-id",
      accessToken: "old-token",
      refreshToken: "stored-refresh-token",
      scopes: ["openid", "https://www.googleapis.com/auth/documents.readonly"],
      createdAt: new Date(),
    });

    await processOAuthCallback({
      provider: "google",
      providerAccountId: "returning-google-id",
      email: "returning@example.com",
      emailVerified: true,
      accessToken: "new-token",
      scopes: ["openid"],
    });

    const [account] = await db
      .select()
      .from(oauthAccounts)
      .where(eq(oauthAccounts.providerAccountId, "returning-google-id"));
    expect(account.accessToken).toBe("new-token");
    expect(account.refreshToken).toBe("stored-refresh-token");
    // The scope list is Google's report of the token, so it replaces the stored one
    expect(account.scopes).toEqual(["openid"]);
  });

  function signInByEmail(providerAccountId: string) {
    return processOAuthCallback({
      provider: "google",
      providerAccountId,
      email: VICTIM_EMAIL,
      emailVerified: true,
      accessToken: `token-${providerAccountId}`,
    });
  }

  describe("signing in by email to a verified account", () => {
    function createVerifiedUser(): Promise<string> {
      return createTestUser({ email: VICTIM_EMAIL });
    }

    it("links the provider and keeps the password and other sessions", async () => {
      // An ordinary sign-in, not a credential change made from Settings
      // (see processOAuthCallback).
      const userId = await createVerifiedUser();
      const { sessionId } = await createSession(db, { userId });

      const result = await signInByEmail("new-device-google-id");

      expect(result.userId).toBe(userId);
      expect(await countOAuthAccounts(userId)).toBe(1);
      const [user] = await db.select().from(users).where(eq(users.id, userId));
      expect(user.passwordHash).not.toBeNull();
      const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId));
      expect(session.revokedAt).toBeNull();
    });

    it("refuses a second account for a provider the user already linked", async () => {
      const userId = await createVerifiedUser();
      await createTestOAuthLink(userId, "google", { providerAccountId: "first-google-id" });

      await expect(signInByEmail("second-google-id")).rejects.toMatchObject({
        cause: { code: "OAUTH_ALREADY_LINKED" },
      });

      const links = await db.select().from(oauthAccounts).where(eq(oauthAccounts.userId, userId));
      expect(links.map((link) => link.providerAccountId)).toEqual(["first-google-id"]);
    });
  });

  describe("signing in by email to an unverified account", () => {
    it("claims it, removing every other way in but keeping the account", async () => {
      // Someone registered the victim's address with a password and set up
      // every kind of credential before the victim ever signed in.
      const userId = await createTestUser({ email: VICTIM_EMAIL, emailVerifiedAt: null });
      const { sessionId } = await createSession(db, { userId });
      const { id: apiTokenId } = await createApiToken(userId, ["mcp"]);
      await createTestOAuthLink(userId, "discord", { providerAccountId: "attacker-discord-id" });
      await createTestTokenGrant(userId);
      await createTestTokenGrant(userId, { clientId: WALLABAG_CLIENT_ID });
      await createAuthorizationCode({
        clientId: "test-client",
        userId,
        redirectUri: "https://example.com/callback",
        scopes: ["mcp"],
        codeChallenge: "challenge",
      });

      const result = await signInByEmail("victim-google-id");

      expect(result.userId).toBe(userId);
      // The registrant's agreements aren't the owner's.
      expect(result.signupConfirmed).toBe(false);
      const [user] = await db.select().from(users).where(eq(users.id, userId));
      expect(user.passwordHash).toBeNull();
      expect(user.emailVerifiedAt).not.toBeNull();
      expect(user.tosAgreedAt).toBeNull();
      const links = await db.select().from(oauthAccounts).where(eq(oauthAccounts.userId, userId));
      expect(links.map((link) => link.providerAccountId)).toEqual(["victim-google-id"]);
      const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId));
      expect(session.revokedAt).not.toBeNull();
      const [apiToken] = await db.select().from(apiTokens).where(eq(apiTokens.id, apiTokenId));
      expect(apiToken.revokedAt).not.toBeNull();
      expect(
        await db.select().from(oauthTokenGrants).where(eq(oauthTokenGrants.userId, userId))
      ).toEqual([]);
      expect(
        await db.select().from(oauthConsentGrants).where(eq(oauthConsentGrants.userId, userId))
      ).toEqual([]);
      expect(
        await db
          .select()
          .from(oauthAuthorizationCodes)
          .where(eq(oauthAuthorizationCodes.userId, userId))
      ).toEqual([]);
    });

    it("links only one of several concurrent first sign-ins with different accounts", async () => {
      const userId = await createTestUser({ email: VICTIM_EMAIL, emailVerifiedAt: null });
      const attempts = 5;
      // Open a pool connection per attempt first, so connection setup doesn't
      // stagger the attempts past the window between the lookup and the insert.
      await Promise.all(Array.from({ length: attempts }, () => db.execute(sql`SELECT 1`)));

      const results = await Promise.allSettled(
        Array.from({ length: attempts }, (_, i) => signInByEmail(`racing-google-id-${i}`))
      );

      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const links = await db.select().from(oauthAccounts).where(eq(oauthAccounts.userId, userId));
      expect(links).toHaveLength(1);
    });
  });
});

/**
 * Integration tests for the shared OAuth callback processor.
 *
 * Focused on the email-verification gate: OAuth sign-in is the only way an email
 * becomes verified in this app, so an unverified provider email must never be
 * trusted to link into — or create — an account (account-takeover defense).
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { eq, and } from "drizzle-orm";
import { db } from "../../src/server/db";
import { users, sessions, oauthAccounts } from "../../src/server/db/schema";
import { generateUuidv7 } from "../../src/lib/uuidv7";
import { processOAuthCallback } from "../../src/server/auth/oauth/callback";
import { createTestUser } from "./helpers";

const VICTIM_EMAIL = "victim@example.com";

async function countOAuthAccounts(userId: string): Promise<number> {
  const rows = await db.select().from(oauthAccounts).where(eq(oauthAccounts.userId, userId));
  return rows.length;
}

describe("processOAuthCallback email verification", () => {
  async function cleanup(): Promise<void> {
    await db.delete(sessions);
    await db.delete(oauthAccounts);
    await db.delete(users);
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

  it("links a verified provider email to the existing account", async () => {
    const victimId = await createTestUser({ email: VICTIM_EMAIL });

    const result = await processOAuthCallback({
      provider: "google",
      providerAccountId: "legit-google-id",
      email: VICTIM_EMAIL,
      emailVerified: true,
      accessToken: "access-token",
    });

    expect(result.isNewUser).toBe(false);
    expect(result.userId).toBe(victimId);
    expect(await countOAuthAccounts(victimId)).toBe(1);

    // Email gets stamped verified once a verified provider links in.
    const [user] = await db.select().from(users).where(eq(users.id, victimId)).limit(1);
    expect(user.emailVerifiedAt).not.toBeNull();
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

    expect(result.isNewUser).toBe(false);
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
      scopes: ["openid", "email", "profile", "docs"],
      createdAt: new Date(),
    });

    await processOAuthCallback({
      provider: "google",
      providerAccountId: "returning-google-id",
      email: "returning@example.com",
      emailVerified: true,
      accessToken: "new-token",
      scopes: ["openid", "email", "profile"],
    });

    const [account] = await db
      .select()
      .from(oauthAccounts)
      .where(eq(oauthAccounts.providerAccountId, "returning-google-id"));
    expect(account.accessToken).toBe("new-token");
    expect(account.refreshToken).toBe("stored-refresh-token");
    // The scope list is Google's report of the token, so it replaces the stored one
    expect(account.scopes).toEqual(["openid", "email", "profile"]);
  });
});

/**
 * Integration tests for linkOAuthAccount.
 *
 * Linking is the same sequence for every provider (see #1467), so these run it
 * against real rows rather than through the three tRPC procedures, which differ
 * only in which provider callback produced the tokens.
 */

import { describe, it, expect, afterAll } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { db } from "../../src/server/db";
import { users, oauthAccounts } from "../../src/server/db/schema";
import { linkOAuthAccount } from "../../src/server/services/oauth-accounts";
import { createTestUser } from "./helpers";

const createdUserIds: string[] = [];

async function createUser(): Promise<string> {
  const userId = await createTestUser({ emailPrefix: "link" });
  createdUserIds.push(userId);
  return userId;
}

async function readLink(userId: string, provider: string) {
  const rows = await db
    .select()
    .from(oauthAccounts)
    .where(and(eq(oauthAccounts.userId, userId), eq(oauthAccounts.provider, provider)));
  return rows;
}

afterAll(async () => {
  if (createdUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
});

describe("linkOAuthAccount", () => {
  it("creates the link with the provider's tokens", async () => {
    const userId = await createUser();
    const expiresAt = new Date(Date.now() + 3600_000);

    const result = await linkOAuthAccount(db, {
      userId,
      provider: "google",
      providerAccountId: `sub-${userId}`,
      accessToken: "access-1",
      refreshToken: "refresh-1",
      expiresAt,
      scopes: ["openid", "email"],
    });

    expect(result).toBe("linked");
    const rows = await readLink(userId, "google");
    expect(rows).toHaveLength(1);
    expect(rows[0].providerAccountId).toBe(`sub-${userId}`);
    expect(rows[0].accessToken).toBe("access-1");
    expect(rows[0].refreshToken).toBe("refresh-1");
    expect(rows[0].expiresAt?.getTime()).toBe(expiresAt.getTime());
    expect(rows[0].scopes).toEqual(["openid", "email"]);
  });

  it("refreshes tokens and scopes when the same account re-links (incremental auth)", async () => {
    const userId = await createUser();
    await linkOAuthAccount(db, {
      userId,
      provider: "google",
      providerAccountId: `sub-${userId}`,
      accessToken: "access-1",
      refreshToken: "refresh-1",
      scopes: ["openid", "email"],
    });

    const result = await linkOAuthAccount(db, {
      userId,
      provider: "google",
      providerAccountId: `sub-${userId}`,
      accessToken: "access-2",
      scopes: ["openid", "email", "https://www.googleapis.com/auth/documents.readonly"],
    });

    expect(result).toBe("updated");
    const rows = await readLink(userId, "google");
    expect(rows).toHaveLength(1);
    expect(rows[0].accessToken).toBe("access-2");
    // Google omits the refresh token on re-consent; the column follows the
    // latest response rather than keeping a token the provider dropped.
    expect(rows[0].refreshToken).toBeNull();
    expect(rows[0].scopes).toContain("https://www.googleapis.com/auth/documents.readonly");
  });

  it("leaves stored scopes alone for providers that don't report them", async () => {
    const userId = await createUser();
    await linkOAuthAccount(db, {
      userId,
      provider: "google",
      providerAccountId: `sub-${userId}`,
      accessToken: "access-1",
      scopes: ["openid", "email"],
    });

    await linkOAuthAccount(db, {
      userId,
      provider: "google",
      providerAccountId: `sub-${userId}`,
      accessToken: "access-2",
    });

    const rows = await readLink(userId, "google");
    expect(rows[0].scopes).toEqual(["openid", "email"]);
  });

  it("refuses a second account for a provider the user already linked", async () => {
    const userId = await createUser();
    await linkOAuthAccount(db, {
      userId,
      provider: "apple",
      providerAccountId: `sub-a-${userId}`,
      accessToken: "access-1",
    });

    await expect(
      linkOAuthAccount(db, {
        userId,
        provider: "apple",
        providerAccountId: `sub-b-${userId}`,
        accessToken: "access-2",
      })
    ).rejects.toThrow(TRPCError);

    const rows = await readLink(userId, "apple");
    expect(rows).toHaveLength(1);
    expect(rows[0].providerAccountId).toBe(`sub-a-${userId}`);
  });

  it("refuses a provider account already linked to another user", async () => {
    const ownerId = await createUser();
    const otherId = await createUser();
    const providerAccountId = `sub-${ownerId}`;
    await linkOAuthAccount(db, {
      userId: ownerId,
      provider: "discord",
      providerAccountId,
      accessToken: "access-1",
    });

    await expect(
      linkOAuthAccount(db, {
        userId: otherId,
        provider: "discord",
        providerAccountId,
        accessToken: "access-2",
      })
    ).rejects.toThrow(/already linked to another user/);

    // The original owner keeps the link, with their own token.
    const rows = await readLink(ownerId, "discord");
    expect(rows).toHaveLength(1);
    expect(rows[0].accessToken).toBe("access-1");
    expect(await readLink(otherId, "discord")).toHaveLength(0);
  });

  it("does not let a concurrent link steal an account from another user", async () => {
    const first = await createUser();
    const second = await createUser();
    const providerAccountId = `sub-race-${first}`;

    // Both users present the same provider account at once. The unique
    // constraint on (provider, provider_account_id) — not a check-then-insert —
    // is what decides, so exactly one wins and no row is overwritten.
    const results = await Promise.allSettled([
      linkOAuthAccount(db, {
        userId: first,
        provider: "discord",
        providerAccountId,
        accessToken: "access-first",
      }),
      linkOAuthAccount(db, {
        userId: second,
        provider: "discord",
        providerAccountId,
        accessToken: "access-second",
      }),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);

    const rows = await db
      .select()
      .from(oauthAccounts)
      .where(
        and(
          eq(oauthAccounts.provider, "discord"),
          eq(oauthAccounts.providerAccountId, providerAccountId)
        )
      );
    expect(rows).toHaveLength(1);
  });
});

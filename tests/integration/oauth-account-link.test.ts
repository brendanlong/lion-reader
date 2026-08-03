/**
 * Integration tests for linkOAuthAccount.
 *
 * Linking is the same sequence for every provider (see #1467), so these run it
 * against real rows rather than through the three tRPC procedures, which differ
 * only in which provider callback produced the tokens.
 */

import { describe, it, expect, afterAll } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
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
    // A re-consent usually returns no refresh token. Keep the one we hold
    // rather than dropping access the user never revoked.
    expect(rows[0].refreshToken).toBe("refresh-1");
    expect(rows[0].scopes).toContain("https://www.googleapis.com/auth/documents.readonly");
  });

  it("clears a stale expiry when the new response has none", async () => {
    const userId = await createUser();
    await linkOAuthAccount(db, {
      userId,
      provider: "google",
      providerAccountId: `sub-${userId}`,
      accessToken: "access-1",
      expiresAt: new Date(Date.now() - 3600_000),
    });

    await linkOAuthAccount(db, {
      userId,
      provider: "google",
      providerAccountId: `sub-${userId}`,
      accessToken: "access-2",
    });

    // The expiry describes the access token in the response, so a past one must
    // not survive next to a fresh token — that re-refreshes forever.
    const rows = await readLink(userId, "google");
    expect(rows[0].expiresAt).toBeNull();
  });

  it.each(["apple", "discord"] as const)(
    "re-linking the same %s account refreshes tokens instead of erroring (#1467)",
    async (provider) => {
      const userId = await createUser();
      await linkOAuthAccount(db, {
        userId,
        provider,
        providerAccountId: `sub-${userId}`,
        accessToken: "access-1",
      });

      const result = await linkOAuthAccount(db, {
        userId,
        provider,
        providerAccountId: `sub-${userId}`,
        accessToken: "access-2",
      });

      expect(result).toBe("updated");
      const rows = await readLink(userId, provider);
      expect(rows).toHaveLength(1);
      expect(rows[0].accessToken).toBe("access-2");
    }
  );

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

    // CONFLICT, specifically: the BAD_REQUEST "linked to another user" error is
    // the wrong one here — this account is free, the *user* is the blocker.
    await expect(
      linkOAuthAccount(db, {
        userId,
        provider: "apple",
        providerAccountId: `sub-b-${userId}`,
        accessToken: "access-2",
      })
    ).rejects.toMatchObject({ code: "CONFLICT" });

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
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: /already linked to another user/ });

    // The original owner keeps the link, with their own token.
    const rows = await readLink(ownerId, "discord");
    expect(rows).toHaveLength(1);
    expect(rows[0].accessToken).toBe("access-1");
    expect(await readLink(otherId, "discord")).toHaveLength(0);
  });

  it("lets only one of two overlapping links claim the same account", async () => {
    const first = await createUser();
    const second = await createUser();
    const providerAccountId = `sub-race-${first}`;

    // Both users present the same provider account. This asserts the invariant
    // (exactly one row, exactly one winner), not the interleaving — the calls
    // are dispatched together but nothing here forces them to overlap inside
    // the insert, and the outcome is the same if they run serially. What makes
    // it hold under real concurrency is that the decision is the unique
    // constraint on (provider, provider_account_id) rather than a preceding
    // SELECT, and that the conflict does nothing instead of updating.
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

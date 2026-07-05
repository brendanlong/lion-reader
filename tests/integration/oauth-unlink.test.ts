/**
 * Integration tests for auth.unlinkProvider.
 *
 * See issue #825: unlinking was a check-then-delete that could race. Two
 * concurrent requests unlinking *different* providers for a password-less
 * user could both observe two linked accounts, both pass the "don't remove
 * the only auth method" check, and both delete — locking the user out. The
 * unlink now runs inside a transaction that takes a FOR UPDATE lock on the
 * user row, serializing concurrent unlinks so at least one account always
 * survives.
 */

import { describe, it, expect, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db } from "../../src/server/db";
import { users, oauthAccounts } from "../../src/server/db/schema";
import { generateUuidv7 } from "../../src/lib/uuidv7";
import { createCaller } from "../../src/server/trpc/root";
import type { Context } from "../../src/server/trpc/context";

const createdUserIds: string[] = [];

async function createTestUser(hasPassword: boolean): Promise<string> {
  const userId = generateUuidv7();
  const now = new Date();
  await db.insert(users).values({
    id: userId,
    email: `unlink-${userId}@test.com`,
    passwordHash: hasPassword ? "test-hash" : null,
    tosAgreedAt: now,
    privacyPolicyAgreedAt: now,
    notEuAgreedAt: now,
    createdAt: now,
    updatedAt: now,
  });
  createdUserIds.push(userId);
  return userId;
}

async function linkProvider(userId: string, provider: string): Promise<void> {
  await db.insert(oauthAccounts).values({
    id: generateUuidv7(),
    userId,
    provider,
    providerAccountId: `${provider}-${userId}`,
  });
}

function createAuthContext(userId: string): Context {
  const now = new Date();
  return {
    db,
    session: {
      session: {
        id: generateUuidv7(),
        userId,
        tokenHash: "test-hash",
        userAgent: null,
        ipAddress: null,
        createdAt: now,
        expiresAt: new Date(Date.now() + 3600000),
        revokedAt: null,
        lastActiveAt: now,
      },
      user: {
        id: userId,
        email: `${userId}@test.com`,
        emailVerifiedAt: null,
        tosAgreedAt: now,
        privacyPolicyAgreedAt: now,
        notEuAgreedAt: now,
        passwordHash: null,
        inviteId: null,
        showSpam: false,
        lastActiveAt: null,
        groqApiKey: null,
        anthropicApiKey: null,
        summarizationModel: null,
        summarizationMaxWords: null,
        summarizationPrompt: null,
        createdAt: now,
        updatedAt: now,
      },
      hasGroqApiKey: false,
      hasAnthropicApiKey: false,
    },
    apiToken: null,
    authType: "session",
    scopes: [],
    sessionToken: "test-token",
    headers: new Headers(),
  };
}

afterAll(async () => {
  if (createdUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
});

describe("auth.unlinkProvider", () => {
  it("unlinks one provider when the user has others", async () => {
    const userId = await createTestUser(false);
    await linkProvider(userId, "google");
    await linkProvider(userId, "apple");
    const caller = createCaller(createAuthContext(userId));

    await caller.auth.unlinkProvider({ provider: "google" });

    const remaining = await db
      .select({ provider: oauthAccounts.provider })
      .from(oauthAccounts)
      .where(eq(oauthAccounts.userId, userId));
    expect(remaining.map((r) => r.provider)).toEqual(["apple"]);
  });

  it("refuses to unlink the only auth method (no password, one provider)", async () => {
    const userId = await createTestUser(false);
    await linkProvider(userId, "google");
    const caller = createCaller(createAuthContext(userId));

    await expect(caller.auth.unlinkProvider({ provider: "google" })).rejects.toThrow();

    const remaining = await db.$count(oauthAccounts, eq(oauthAccounts.userId, userId));
    expect(remaining).toBe(1);
  });

  it("allows unlinking the last provider when the user has a password", async () => {
    const userId = await createTestUser(true);
    await linkProvider(userId, "google");
    const caller = createCaller(createAuthContext(userId));

    await caller.auth.unlinkProvider({ provider: "google" });

    const remaining = await db.$count(oauthAccounts, eq(oauthAccounts.userId, userId));
    expect(remaining).toBe(0);
  });

  it("is idempotent when the provider is already unlinked", async () => {
    const userId = await createTestUser(true);
    await linkProvider(userId, "google");
    const caller = createCaller(createAuthContext(userId));

    const result = await caller.auth.unlinkProvider({ provider: "apple" });
    expect(result).toEqual({ success: true });
    // The linked provider is untouched.
    const remaining = await db.$count(oauthAccounts, eq(oauthAccounts.userId, userId));
    expect(remaining).toBe(1);
  });

  it("keeps at least one auth method when two providers are unlinked concurrently (#825)", async () => {
    const userId = await createTestUser(false);
    await linkProvider(userId, "google");
    await linkProvider(userId, "apple");

    // Two concurrent unlinks of *different* providers, as if from two tabs.
    // The FOR UPDATE lock serializes them: the first to acquire the lock
    // succeeds; the second re-reads the (now single) remaining account and
    // is blocked by the "only auth method" guard.
    const caller = createCaller(createAuthContext(userId));
    const results = await Promise.allSettled([
      caller.auth.unlinkProvider({ provider: "google" }),
      caller.auth.unlinkProvider({ provider: "apple" }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled").length;
    const rejected = results.filter((r) => r.status === "rejected").length;
    expect(fulfilled).toBe(1);
    expect(rejected).toBe(1);

    // Critically: the user is not locked out — exactly one provider remains.
    const remaining = await db.$count(oauthAccounts, eq(oauthAccounts.userId, userId));
    expect(remaining).toBe(1);
  });
});

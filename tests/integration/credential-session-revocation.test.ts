/**
 * Integration tests for session revocation on credential changes.
 *
 * Every credential change SECURITY.md §4 covers — setting a password, changing
 * it, linking a provider, unlinking one — must leave only the calling session
 * alive, and the changes that only look like one must leave every session alone.
 *
 * The sessions here are real rows validated through `validateSession`, so the
 * test covers the Redis cache eviction too: a cached session still validates
 * until its key is deleted, so revoking in Postgres alone would not be enough.
 */

import { describe, it, expect, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import * as argon2 from "argon2";
import { db } from "../../src/server/db";
import { sessions, users } from "../../src/server/db/schema";
import { createSession, validateSession } from "../../src/server/auth/session";
import { linkOAuthAccount } from "../../src/server/services/oauth-accounts";
import { createCaller } from "../../src/server/trpc/root";
import type { Context } from "../../src/server/trpc/context";
import { createAuthContext, createTestOAuthLink, createTestUser } from "./helpers";

const createdUserIds: string[] = [];

/** Creates a user and remembers it for cleanup. */
async function createUser(overrides: Partial<typeof users.$inferInsert> = {}): Promise<string> {
  const userId = await createTestUser({ emailPrefix: "cred-revoke", ...overrides });
  createdUserIds.push(userId);
  return userId;
}

/**
 * Builds a context whose `session.session` is a **real** `sessions` row, so the
 * procedure's "keep the current session" argument refers to something the test
 * can then validate. `createAuthContext` alone invents a synthetic session id,
 * which would make every real session look like an "other" session.
 */
async function createSessionContext(userId: string, sessionId: string): Promise<Context> {
  const base = await createAuthContext(userId);
  if (!base.session) {
    throw new Error("createAuthContext returned no session");
  }
  const [row] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
  if (!row) {
    throw new Error(`no session row with id ${sessionId}`);
  }
  return { ...base, session: { ...base.session, session: row } };
}

afterAll(async () => {
  if (createdUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
});

describe("credential changes revoke other sessions", () => {
  it("me.setPassword revokes other sessions and keeps the caller's", async () => {
    // An OAuth-only account: no password yet.
    const userId = await createUser({ passwordHash: null });
    const current = await createSession(db, { userId });
    const other = await createSession(db, { userId });

    // Warm both through the real validation path (this also fills the Redis
    // cache, so the revoke has to evict it to take effect).
    expect(await validateSession(current.token)).not.toBeNull();
    expect(await validateSession(other.token)).not.toBeNull();

    const caller = createCaller(await createSessionContext(userId, current.sessionId));
    await expect(
      caller.users["me.setPassword"]({ newPassword: "a-new-password" })
    ).resolves.toEqual({ success: true });

    // The leaked/lingering session is dead...
    expect(await validateSession(other.token)).toBeNull();
    // ...and the session that set the password is still usable.
    expect(await validateSession(current.token)).not.toBeNull();
  });

  it("me.changePassword revokes other sessions and keeps the caller's", async () => {
    const userId = await createUser({ passwordHash: await argon2.hash("old-password") });
    const current = await createSession(db, { userId });
    const other = await createSession(db, { userId });

    expect(await validateSession(current.token)).not.toBeNull();
    expect(await validateSession(other.token)).not.toBeNull();

    const caller = createCaller(await createSessionContext(userId, current.sessionId));
    await expect(
      caller.users["me.changePassword"]({
        currentPassword: "old-password",
        newPassword: "a-new-password",
      })
    ).resolves.toEqual({ success: true });

    expect(await validateSession(other.token)).toBeNull();
    expect(await validateSession(current.token)).not.toBeNull();
  });

  it("linking a new provider revokes other sessions and keeps the caller's", async () => {
    // The three link procedures differ only in which provider callback produced
    // the tokens, so the revoke is asserted once against the service they share
    // (mirroring `oauth-account-link.test.ts`).
    const userId = await createUser({ passwordHash: await argon2.hash("password") });
    const current = await createSession(db, { userId });
    const other = await createSession(db, { userId });

    expect(await validateSession(current.token)).not.toBeNull();
    expect(await validateSession(other.token)).not.toBeNull();

    await expect(
      linkOAuthAccount(db, {
        userId,
        currentSessionId: current.sessionId,
        provider: "google",
        providerAccountId: `sub-${userId}`,
        accessToken: "access-1",
      })
    ).resolves.toBe("linked");

    expect(await validateSession(other.token)).toBeNull();
    expect(await validateSession(current.token)).not.toBeNull();
  });

  it("re-linking the same provider account leaves other sessions alone", async () => {
    // Incremental authorization (granting the Google Docs scope) re-links the
    // account the user already has. That adds no way to sign in, so logging
    // their other devices out for granting a permission would be gratuitous.
    const userId = await createUser({ passwordHash: await argon2.hash("password") });
    const first = await createSession(db, { userId });
    await linkOAuthAccount(db, {
      userId,
      currentSessionId: first.sessionId,
      provider: "google",
      providerAccountId: `sub-${userId}`,
      accessToken: "access-1",
    });

    const current = await createSession(db, { userId });
    const other = await createSession(db, { userId });

    await expect(
      linkOAuthAccount(db, {
        userId,
        currentSessionId: current.sessionId,
        provider: "google",
        providerAccountId: `sub-${userId}`,
        accessToken: "access-2",
        scopes: ["openid", "email", "https://www.googleapis.com/auth/documents.readonly"],
      })
    ).resolves.toBe("updated");

    expect(await validateSession(other.token)).not.toBeNull();
    expect(await validateSession(current.token)).not.toBeNull();
  });

  it("auth.unlinkProvider revokes other sessions and keeps the caller's", async () => {
    // The sharp case: the user is unlinking a provider account they think is
    // compromised, so the attacker's session must not outlive the unlink.
    const userId = await createUser({ passwordHash: await argon2.hash("password") });
    await createTestOAuthLink(userId, "google");
    const current = await createSession(db, { userId });
    const other = await createSession(db, { userId });

    expect(await validateSession(current.token)).not.toBeNull();
    expect(await validateSession(other.token)).not.toBeNull();

    const caller = createCaller(await createSessionContext(userId, current.sessionId));
    await expect(caller.auth.unlinkProvider({ provider: "google" })).resolves.toEqual({
      success: true,
    });

    expect(await validateSession(other.token)).toBeNull();
    expect(await validateSession(current.token)).not.toBeNull();
  });

  it("a no-op auth.unlinkProvider leaves other sessions alone", async () => {
    // Nothing was linked, so no credential changed.
    const userId = await createUser({ passwordHash: await argon2.hash("password") });
    const current = await createSession(db, { userId });
    const other = await createSession(db, { userId });

    const caller = createCaller(await createSessionContext(userId, current.sessionId));
    await expect(caller.auth.unlinkProvider({ provider: "apple" })).resolves.toEqual({
      success: true,
    });

    expect(await validateSession(other.token)).not.toBeNull();
    expect(await validateSession(current.token)).not.toBeNull();
  });

  it("a refused auth.unlinkProvider leaves other sessions alone", async () => {
    // The "don't remove your only auth method" guard throws inside the unlink's
    // transaction, so the revoke it wraps rolls back with it.
    const userId = await createUser({ passwordHash: null });
    await createTestOAuthLink(userId, "google");
    const current = await createSession(db, { userId });
    const other = await createSession(db, { userId });

    const caller = createCaller(await createSessionContext(userId, current.sessionId));
    await expect(caller.auth.unlinkProvider({ provider: "google" })).rejects.toThrow();

    expect(await validateSession(other.token)).not.toBeNull();
    expect(await validateSession(current.token)).not.toBeNull();
  });

  it("a rejected me.setPassword leaves other sessions alone", async () => {
    // Already has a password, so setPassword must fail — and a failed credential
    // change must not log the user's other devices out.
    const userId = await createUser({ passwordHash: await argon2.hash("existing-password") });
    const current = await createSession(db, { userId });
    const other = await createSession(db, { userId });

    const caller = createCaller(await createSessionContext(userId, current.sessionId));
    await expect(caller.users["me.setPassword"]({ newPassword: "a-new-password" })).rejects.toThrow(
      /already has a password/i
    );

    expect(await validateSession(other.token)).not.toBeNull();
    expect(await validateSession(current.token)).not.toBeNull();
  });
});

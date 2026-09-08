/**
 * Integration tests for session revocation on credential changes.
 *
 * SECURITY.md §4: "Password change (and any credential change) must revoke other
 * sessions." Both `users."me.setPassword"` (an OAuth-only account adding a
 * password) and `users."me.changePassword"` are credential changes, so both must
 * leave only the calling session alive — otherwise an attacker holding a leaked
 * session token survives the very action the user took to secure the account.
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
import { createCaller } from "../../src/server/trpc/root";
import type { Context } from "../../src/server/trpc/context";
import { createAuthContext, createTestUser } from "./helpers";

const createdUserIds: string[] = [];

/** Creates a user and remembers it for cleanup. */
async function createUser(overrides: Partial<typeof users.$inferInsert> = {}): Promise<string> {
  const userId = await createTestUser({ emailPrefix: "pw-revoke", ...overrides });
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

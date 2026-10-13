/**
 * Integration tests for session activity tracking: authenticated requests
 * report activity, so a row is only written once its timestamp is stale.
 */

import { describe, it, expect, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db } from "../../src/server/db";
import { sessions, users } from "../../src/server/db/schema";
import {
  createSession,
  invalidateUserSessionCaches,
  LAST_ACTIVE_REFRESH_MS,
  updateLastActiveAt,
  validateSession,
} from "../../src/server/auth/session";
import { createTestUser } from "./helpers";

const createdUserIds: string[] = [];

afterAll(async () => {
  if (createdUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
});

/** A user with one session, both last active `ageMs` ago. */
async function createActiveSession(ageMs: number) {
  const lastActiveAt = new Date(Date.now() - ageMs);
  const userId = await createTestUser({ emailPrefix: "last-active", lastActiveAt });
  createdUserIds.push(userId);
  const { sessionId, token } = await createSession(db, { userId });
  await db.update(sessions).set({ lastActiveAt }).where(eq(sessions.id, sessionId));
  return { userId, sessionId, token, lastActiveAt };
}

async function lastActive(userId: string, sessionId: string) {
  const [session] = await db
    .select({ lastActiveAt: sessions.lastActiveAt })
    .from(sessions)
    .where(eq(sessions.id, sessionId));
  const [user] = await db
    .select({ lastActiveAt: users.lastActiveAt })
    .from(users)
    .where(eq(users.id, userId));
  return { session: session.lastActiveAt, user: user.lastActiveAt };
}

describe("updateLastActiveAt", () => {
  it.each([false, true])(
    "leaves rows active within the refresh window alone (scoped: %s)",
    async (isScoped) => {
      const { userId, sessionId, lastActiveAt } = await createActiveSession(
        LAST_ACTIVE_REFRESH_MS - 5_000
      );

      await updateLastActiveAt(sessionId, userId, isScoped);

      expect(await lastActive(userId, sessionId)).toEqual({
        session: lastActiveAt,
        user: lastActiveAt,
      });
    }
  );

  it("refreshes a full-access session and its user once stale", async () => {
    const { userId, sessionId, lastActiveAt } = await createActiveSession(
      LAST_ACTIVE_REFRESH_MS + 5_000
    );

    await updateLastActiveAt(sessionId, userId, false);

    const after = await lastActive(userId, sessionId);
    expect(after.session.getTime()).toBeGreaterThan(lastActiveAt.getTime());
    expect(after.user!.getTime()).toBeGreaterThan(lastActiveAt.getTime());
  });
});

/** Lets a fire-and-forget write that was going to happen land. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 200));

describe("validateSession", () => {
  it("records activity when it reads the session from Postgres, not from the cache", async () => {
    const stale = LAST_ACTIVE_REFRESH_MS + 5_000;
    const { userId, sessionId, token, lastActiveAt } = await createActiveSession(stale);
    const sessionLastActive = async () => (await lastActive(userId, sessionId)).session;

    // Cache miss: read from Postgres, so activity is recorded.
    expect(await validateSession(token)).not.toBeNull();
    await expect.poll(sessionLastActive).not.toEqual(lastActiveAt);

    // Cache hit: no write, however stale the row.
    const restaled = new Date(Date.now() - stale);
    await db.update(sessions).set({ lastActiveAt: restaled }).where(eq(sessions.id, sessionId));
    expect(await validateSession(token)).not.toBeNull();
    await settle();
    expect(await sessionLastActive()).toEqual(restaled);

    // Once the cached copy is gone, the next read records activity again.
    await invalidateUserSessionCaches(userId);
    expect(await validateSession(token)).not.toBeNull();
    await expect.poll(sessionLastActive).not.toEqual(restaled);
  });
});

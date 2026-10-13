/**
 * Integration tests for session activity tracking: every authenticated request
 * reports activity, so a row is only written once its timestamp is stale.
 */

import { describe, it, expect, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db } from "../../src/server/db";
import { sessions, users } from "../../src/server/db/schema";
import {
  createSession,
  LAST_ACTIVE_REFRESH_MS,
  updateLastActiveAt,
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
  const { sessionId } = await createSession(db, { userId });
  await db.update(sessions).set({ lastActiveAt }).where(eq(sessions.id, sessionId));
  return { userId, sessionId, lastActiveAt };
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

  it("refreshes only the session row of a stale scoped session", async () => {
    const { userId, sessionId, lastActiveAt } = await createActiveSession(
      LAST_ACTIVE_REFRESH_MS + 5_000
    );

    await updateLastActiveAt(sessionId, userId, true);

    const after = await lastActive(userId, sessionId);
    expect(after.session.getTime()).toBeGreaterThan(lastActiveAt.getTime());
    expect(after.user).toEqual(lastActiveAt);
  });
});

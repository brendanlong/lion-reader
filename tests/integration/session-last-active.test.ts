/**
 * Integration tests for credential activity tracking: authenticated requests
 * report activity, so a row is only written once its timestamp is stale.
 */

import { describe, it, expect, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db } from "../../src/server/db";
import { apiTokens, sessions, users } from "../../src/server/db/schema";
import {
  createSession,
  invalidateUserSessionCaches,
  LAST_ACTIVE_REFRESH_MS,
  updateLastActiveAt,
  validateSession,
} from "../../src/server/auth/session";
import { createApiToken, validateApiToken } from "../../src/server/auth/api-token";
import { LAST_USED_REFRESH_MS } from "../../src/server/oauth/utils";
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

  it("records a scoped session's activity even after a full-access caller rejected it", async () => {
    const { userId, sessionId, lastActiveAt } = await createActiveSession(
      LAST_ACTIVE_REFRESH_MS + 5_000
    );
    await db.delete(sessions).where(eq(sessions.id, sessionId));
    const scoped = await createSession(db, { userId, scopes: ["reader:full-access"] });
    await db.update(sessions).set({ lastActiveAt }).where(eq(sessions.id, scoped.sessionId));

    // A rejecting caller mustn't leave a cached copy whose hits record nothing.
    expect(await validateSession(scoped.token)).toBeNull();
    expect(await validateSession(scoped.token, { allowScoped: true })).not.toBeNull();
    await expect
      .poll(async () => (await lastActive(userId, scoped.sessionId)).session)
      .not.toEqual(lastActiveAt);
  });
});

describe("validateApiToken", () => {
  it("rewrites last_used_at only once it's stale", async () => {
    const userId = await createTestUser({ emailPrefix: "last-used" });
    createdUserIds.push(userId);
    const { token, id } = await createApiToken(userId, ["mcp"]);
    const lastUsedAt = async () =>
      (await db.select({ at: apiTokens.lastUsedAt }).from(apiTokens).where(eq(apiTokens.id, id)))[0]
        .at;

    const fresh = new Date(Date.now() - (LAST_USED_REFRESH_MS - 5_000));
    await db.update(apiTokens).set({ lastUsedAt: fresh }).where(eq(apiTokens.id, id));
    expect(await validateApiToken(token)).not.toBeNull();
    await settle();
    expect(await lastUsedAt()).toEqual(fresh);

    const stale = new Date(Date.now() - (LAST_USED_REFRESH_MS + 5_000));
    await db.update(apiTokens).set({ lastUsedAt: stale }).where(eq(apiTokens.id, id));
    expect(await validateApiToken(token)).not.toBeNull();
    await expect.poll(lastUsedAt).not.toEqual(stale);
  });
});

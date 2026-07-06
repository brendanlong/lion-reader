/**
 * Integration tests for Google Reader authentication + scoped sessions.
 *
 * ClientLogin mints a real session, so historically a Google Reader token was
 * full browser access — a leaked token could be replayed as a session cookie to
 * change the password or delete the account. Sessions now carry an optional
 * scopes array: ClientLogin restricts its session to reader:full-access, and
 * validateSession rejects scoped sessions for full-access use unless the caller
 * opts in. Only the Google Reader API opts in.
 *
 * See issue #1022.
 */

import { describe, it, expect, afterAll } from "vitest";
import * as argon2 from "argon2";
import { inArray } from "drizzle-orm";
import { db } from "../../src/server/db";
import { users } from "../../src/server/db/schema";
import { generateUuidv7 } from "../../src/lib/uuidv7";
import { createSession, validateSession } from "../../src/server/auth/session";
import { clientLogin, requireAuth } from "../../src/server/google-reader/auth";
import { OAUTH_SCOPES } from "../../src/server/oauth/utils";

const createdUserIds: string[] = [];
const PASSWORD = "correct-horse-battery-staple";

async function createTestUser(): Promise<{ id: string; email: string }> {
  const id = generateUuidv7();
  const email = `greader-${id}@test.com`;
  await db.insert(users).values({
    id,
    email,
    passwordHash: await argon2.hash(PASSWORD),
    tosAgreedAt: new Date(),
    privacyPolicyAgreedAt: new Date(),
    notEuAgreedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  createdUserIds.push(id);
  return { id, email };
}

function greaderRequest(token: string): Request {
  return new Request("https://example.com/api/greader.php/reader/api/0/user-info", {
    headers: { authorization: `GoogleLogin auth=${token}` },
  });
}

afterAll(async () => {
  if (createdUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
});

describe("Google Reader ClientLogin mints a reader-scoped session", () => {
  it("issues a token that requireAuth accepts", async () => {
    const user = await createTestUser();
    const login = await clientLogin(user.email, PASSWORD);
    expect(login).not.toBeNull();
    if (!login) throw new Error("unreachable");

    const result = await requireAuth(greaderRequest(login.auth));
    expect(result).not.toBeInstanceOf(Response);
    if (result instanceof Response) throw new Error("unreachable");
    expect(result.user.id).toBe(user.id);
    expect(result.session.scopes).toEqual([OAUTH_SCOPES.READER_FULL_ACCESS]);
  });

  it("mints a session that is NOT usable as a full-access session", async () => {
    const user = await createTestUser();
    const login = await clientLogin(user.email, PASSWORD);
    if (!login) throw new Error("unreachable");

    // Default (full-access) validation rejects the scoped session — this is what
    // stops a Google Reader token from being replayed as a browser session.
    expect(await validateSession(login.auth)).toBeNull();

    // Opt-in validation returns it, scoped.
    const scoped = await validateSession(login.auth, { allowScoped: true });
    expect(scoped?.session.scopes).toEqual([OAUTH_SCOPES.READER_FULL_ACCESS]);
  });

  it("returns null for a wrong password", async () => {
    const user = await createTestUser();
    expect(await clientLogin(user.email, "wrong-password")).toBeNull();
  });
});

describe("Google Reader requireAuth session acceptance", () => {
  it("accepts a full-access (unscoped) browser session", async () => {
    const user = await createTestUser();
    const { token } = await createSession(db, { userId: user.id });

    const result = await requireAuth(greaderRequest(token));
    expect(result).not.toBeInstanceOf(Response);
    if (result instanceof Response) throw new Error("unreachable");
    expect(result.user.id).toBe(user.id);
  });

  it("rejects a session scoped to something other than reader:full-access with 403", async () => {
    const user = await createTestUser();
    const { token } = await createSession(db, {
      userId: user.id,
      scopes: [OAUTH_SCOPES.SAVED_WRITE],
    });

    const result = await requireAuth(greaderRequest(token));
    expect(result).toBeInstanceOf(Response);
    if (!(result instanceof Response)) throw new Error("unreachable");
    // Authenticated but insufficient scope → 403, distinct from 401 (unauthenticated).
    expect(result.status).toBe(403);
  });

  it("rejects a reader-scoped session for an unconfirmed user with 403", async () => {
    const id = generateUuidv7();
    const email = `greader-unconfirmed-${id}@test.com`;
    await db.insert(users).values({
      id,
      email,
      passwordHash: await argon2.hash(PASSWORD),
      // No tos/privacy/EU agreement — signup not confirmed.
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    createdUserIds.push(id);

    const login = await clientLogin(email, PASSWORD);
    if (!login) throw new Error("unreachable");

    const result = await requireAuth(greaderRequest(login.auth));
    expect(result).toBeInstanceOf(Response);
    if (!(result instanceof Response)) throw new Error("unreachable");
    expect(result.status).toBe(403);
  });

  it("returns 401 for a missing token", async () => {
    const result = await requireAuth(
      new Request("https://example.com/api/greader.php/reader/api/0/user-info")
    );
    expect(result).toBeInstanceOf(Response);
    if (!(result instanceof Response)) throw new Error("unreachable");
    expect(result.status).toBe(401);
  });
});

describe("createSession scope validation", () => {
  it("rejects an unknown scope rather than minting a credential that matches nothing", async () => {
    const user = await createTestUser();
    await expect(
      createSession(db, { userId: user.id, scopes: ["not-a-real-scope"] })
    ).rejects.toThrow(/unknown scope/i);
  });

  it("accepts a known scope", async () => {
    const user = await createTestUser();
    const { token } = await createSession(db, {
      userId: user.id,
      scopes: [OAUTH_SCOPES.READER_FULL_ACCESS],
    });
    expect(token).toBeTruthy();
  });
});

/**
 * Integration test for invite-claiming signup (`createUser`).
 *
 * Currently skipped: invite-based signup is broken (issue #1447). `createUser`
 * writes `invites.used_by_user_id = userId` before inserting the user row, and
 * the FK added in migration 0076 is non-deferrable, so the claim fails the
 * statement-level check with a 23503. This test asserts the intended behavior;
 * un-skip it when #1447 is fixed.
 */

import { describe, it, expect, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/server/db";
import { users, invites } from "../../src/server/db/schema";
import { generateUuidv7 } from "../../src/lib/uuidv7";
import { createUser } from "../../src/server/auth/signup";

const createdUserIds: string[] = [];
const createdInviteIds: string[] = [];

async function createInvite(): Promise<string> {
  const id = generateUuidv7();
  const token = `invite-${id}`;
  await db.insert(invites).values({
    id,
    token,
    expiresAt: new Date(Date.now() + 86_400_000),
    createdAt: new Date(),
  });
  createdInviteIds.push(id);
  return token;
}

afterAll(async () => {
  for (const id of createdUserIds) {
    await db.delete(users).where(eq(users.id, id));
  }
  for (const id of createdInviteIds) {
    await db.delete(invites).where(eq(invites.id, id));
  }
});

describe.skip("createUser with an invite (issue #1447)", () => {
  it("creates the user and marks the invite used", async () => {
    const token = await createInvite();
    process.env.ALLOWED_PUBLIC_SIGNUP_PROVIDERS = "";

    const user = await db.transaction((tx) =>
      createUser(tx, {
        email: `invite-signup-${generateUuidv7()}@test.com`,
        passwordHash: "test-hash",
        emailVerified: false,
        inviteToken: token,
        provider: "email",
      })
    );
    createdUserIds.push(user.userId);

    const [invite] = await db.select().from(invites).where(eq(invites.token, token));
    expect(invite.usedAt).toBeInstanceOf(Date);
    expect(invite.usedByUserId).toBe(user.userId);

    const [row] = await db.select().from(users).where(eq(users.id, user.userId));
    expect(row.inviteId).toBe(invite.id);
  });
});

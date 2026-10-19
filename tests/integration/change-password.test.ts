/**
 * Integration tests for me.changePassword's guessing protection.
 *
 * Changing the password checks the current one, so it is a password endpoint
 * like login (SECURITY.md §4): attempts count against the per-account bucket
 * login shares, not only the caller's ordinary per-user limit.
 */

import { describe, it, expect, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db } from "../../src/server/db";
import { users } from "../../src/server/db/schema";
import { hashPassword, verifyPassword } from "../../src/server/auth/password";
import { checkAccountRateLimit } from "../../src/server/rate-limit";
import { createCaller } from "../../src/server/trpc/root";
import { createAuthContext, createTestUser } from "./helpers";

const createdUserIds: string[] = [];

afterAll(async () => {
  if (createdUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
});

async function storedHash(userId: string): Promise<string | null> {
  const [user] = await db
    .select({ passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.id, userId));
  return user.passwordHash;
}

describe("me.changePassword", () => {
  it("is refused once the account's password bucket is spent", async () => {
    const userId = await createTestUser({
      emailPrefix: "change-password",
      passwordHash: await hashPassword("current-password"),
    });
    createdUserIds.push(userId);
    const [{ email }] = await db.select().from(users).where(eq(users.id, userId));

    // Spend the bucket the way failed logins for this email would.
    while ((await checkAccountRateLimit(email)).allowed) {
      // keep consuming
    }

    const caller = createCaller(await createAuthContext(userId));
    await expect(
      caller.users["me.changePassword"]({
        currentPassword: "current-password",
        newPassword: "a-new-password",
      })
    ).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });

    expect(await verifyPassword(await storedHash(userId), "current-password")).toBe(true);
  });
});

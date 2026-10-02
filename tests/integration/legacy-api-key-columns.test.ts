/**
 * Migration 0117: the last copy of the old users.<provider>_api_key columns
 * into user_api_keys. Migrations already ran against the test database, so the
 * file is replayed over seeded users.
 */

import { readFileSync } from "fs";
import { describe, it, expect } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../../src/server/db";
import { userApiKeys } from "../../src/server/db/schema";
import { createTestUser } from "./helpers";

const migration = readFileSync(
  new URL("../../migrations/0117_legacy_api_key_columns_final_copy.sql", import.meta.url),
  "utf8"
);

async function setColumn(userId: string, value: string | null): Promise<void> {
  await db.execute(sql`UPDATE users SET groq_api_key = ${value} WHERE id = ${userId}`);
}

async function storedKey(userId: string): Promise<string | undefined> {
  const [row] = await db
    .select({ key: userApiKeys.encryptedKey })
    .from(userApiKeys)
    .where(and(eq(userApiKeys.userId, userId), eq(userApiKeys.provider, "groq")));
  return row?.key;
}

describe("migration 0117", () => {
  it("copies what the old columns still hold over the table, then empties them", async () => {
    const changedByOldRelease = await createTestUser();
    await db
      .insert(userApiKeys)
      .values({ userId: changedByOldRelease, provider: "groq", encryptedKey: "copied-by-0116" });
    await setColumn(changedByOldRelease, "set-later-by-old-release");

    const neverCopied = await createTestUser();
    await setColumn(neverCopied, "set-by-old-release");

    const changedSince = await createTestUser();
    await db
      .insert(userApiKeys)
      .values({ userId: changedSince, provider: "groq", encryptedKey: "set-by-new-release" });

    await db.execute(sql.raw(migration));

    expect(await storedKey(changedByOldRelease)).toBe("set-later-by-old-release");
    expect(await storedKey(neverCopied)).toBe("set-by-old-release");
    expect(await storedKey(changedSince)).toBe("set-by-new-release");
    const remaining = await db.execute<{ count: string }>(
      sql`SELECT count(*) FROM users WHERE groq_api_key IS NOT NULL`
    );
    expect(Number(remaining.rows[0].count)).toBe(0);
  });
});

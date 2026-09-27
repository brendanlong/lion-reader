/**
 * Integration tests for per-user AI provider API keys: stored encrypted,
 * exposed to the client only as has-key booleans, and decrypted on demand.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../../src/server/db";
import { users } from "../../src/server/db/schema";
import { createCaller } from "../../src/server/trpc/root";
import { getUserApiKeys } from "../../src/server/auth/session";
import { createAuthContext, createTestUser } from "./helpers";

const previousEncryptionKey = process.env.API_KEY_ENCRYPTION_KEY;

beforeAll(() => {
  process.env.API_KEY_ENCRYPTION_KEY = randomBytes(32).toString("base64");
});

afterAll(() => {
  if (previousEncryptionKey === undefined) delete process.env.API_KEY_ENCRYPTION_KEY;
  else process.env.API_KEY_ENCRYPTION_KEY = previousEncryptionKey;
});

describe("OpenRouter API key", () => {
  it("round-trips through preferences without exposing the key", async () => {
    const userId = await createTestUser();
    const caller = createCaller(await createAuthContext(userId));

    const updated = await caller.users["me.updatePreferences"]({
      openrouterApiKey: "sk-or-test-key",
    });
    expect(updated.hasOpenrouterApiKey).toBe(true);
    expect(JSON.stringify(updated)).not.toContain("sk-or-test-key");

    const [row] = await db
      .select({ openrouterApiKey: users.openrouterApiKey })
      .from(users)
      .where(eq(users.id, userId));
    expect(row.openrouterApiKey).toBeTruthy();
    expect(row.openrouterApiKey).not.toContain("sk-or-test-key");

    expect((await getUserApiKeys(userId)).openrouterApiKey).toBe("sk-or-test-key");

    // A fresh session (what the next request sees) reports the key too.
    const freshCaller = createCaller(await createAuthContext(userId));
    expect((await freshCaller.users["me.preferences"]()).hasOpenrouterApiKey).toBe(true);
  });

  it("clears the key when set to an empty string", async () => {
    const userId = await createTestUser();
    const caller = createCaller(await createAuthContext(userId));
    await caller.users["me.updatePreferences"]({ openrouterApiKey: "sk-or-test-key" });

    const cleared = await caller.users["me.updatePreferences"]({ openrouterApiKey: "" });
    expect(cleared.hasOpenrouterApiKey).toBe(false);
    expect((await getUserApiKeys(userId)).openrouterApiKey).toBeNull();
  });
});

describe("cloud voices", () => {
  const previousServerKey = process.env.OPENROUTER_API_KEY;
  beforeAll(() => {
    delete process.env.OPENROUTER_API_KEY;
  });
  afterAll(() => {
    if (previousServerKey !== undefined) process.env.OPENROUTER_API_KEY = previousServerKey;
  });

  it("are unavailable without an OpenRouter key", async () => {
    const userId = await createTestUser();
    const caller = createCaller(await createAuthContext(userId));

    expect((await caller.narration.listVoiceModels()).models).toEqual([]);
    await expect(
      caller.narration.synthesize({ model: null, voice: null, text: "Hello." })
    ).rejects.toThrow("Cloud voices require an OpenRouter API key");
  });
});

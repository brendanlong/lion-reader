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

describe.each([
  { name: "OpenRouter", field: "openrouterApiKey", has: "hasOpenrouterApiKey" },
  { name: "DeepInfra", field: "deepinfraApiKey", has: "hasDeepinfraApiKey" },
] as const)("$name API key", ({ field, has }) => {
  it("round-trips through preferences without exposing the key", async () => {
    const userId = await createTestUser();
    const caller = createCaller(await createAuthContext(userId));

    const updated = await caller.users["me.updatePreferences"]({ [field]: "sk-test-key" });
    expect(updated[has]).toBe(true);
    expect(JSON.stringify(updated)).not.toContain("sk-test-key");

    const [row] = await db.select({ stored: users[field] }).from(users).where(eq(users.id, userId));
    expect(row.stored).toBeTruthy();
    expect(row.stored).not.toContain("sk-test-key");

    expect((await getUserApiKeys(userId))[field]).toBe("sk-test-key");

    // A fresh session (what the next request sees) reports the key too.
    const freshCaller = createCaller(await createAuthContext(userId));
    expect((await freshCaller.users["me.preferences"]())[has]).toBe(true);
  });

  it("clears the key when set to an empty string", async () => {
    const userId = await createTestUser();
    const caller = createCaller(await createAuthContext(userId));
    await caller.users["me.updatePreferences"]({ [field]: "sk-test-key" });

    const cleared = await caller.users["me.updatePreferences"]({ [field]: "" });
    expect(cleared[has]).toBe(false);
    expect((await getUserApiKeys(userId))[field]).toBeNull();
  });
});

describe("cloud voices", () => {
  const serverKeys = ["OPENROUTER_API_KEY", "DEEPINFRA_API_KEY"] as const;
  const previous = Object.fromEntries(serverKeys.map((name) => [name, process.env[name]]));
  beforeAll(() => {
    for (const name of serverKeys) delete process.env[name];
  });
  afterAll(() => {
    for (const name of serverKeys) {
      if (previous[name] !== undefined) process.env[name] = previous[name];
    }
  });

  it("are unavailable without a DeepInfra or OpenRouter key", async () => {
    const userId = await createTestUser();
    const caller = createCaller(await createAuthContext(userId));

    expect((await caller.narration.listVoiceModels()).models).toEqual([]);
    await expect(
      caller.narration.synthesize({ model: null, voice: null, text: "Hello." })
    ).rejects.toThrow("Cloud voices require a DeepInfra or OpenRouter API key");
  });
});

/**
 * Integration tests for per-user AI provider API keys: stored encrypted,
 * exposed to the client only as which providers have one, and decrypted on
 * demand.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "../../src/server/db";
import { userApiKeys } from "../../src/server/db/schema";
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

describe.each(["openrouter", "deepinfra"] as const)("%s API key", (provider) => {
  it("round-trips through preferences without exposing the key", async () => {
    const userId = await createTestUser();
    const caller = createCaller(await createAuthContext(userId));

    const updated = await caller.users["me.updatePreferences"]({
      apiKeys: { [provider]: "sk-test-key" },
    });
    expect(updated.apiKeyProviders).toEqual([provider]);
    expect(JSON.stringify(updated)).not.toContain("sk-test-key");

    const [row] = await db
      .select({ stored: userApiKeys.encryptedKey })
      .from(userApiKeys)
      .where(and(eq(userApiKeys.userId, userId), eq(userApiKeys.provider, provider)));
    expect(row.stored).toBeTruthy();
    expect(row.stored).not.toContain("sk-test-key");

    expect((await getUserApiKeys(userId))[provider]).toBe("sk-test-key");
    expect((await caller.users["me.preferences"]()).apiKeyProviders).toEqual([provider]);
  });

  it("replaces the key when set again", async () => {
    const userId = await createTestUser();
    const caller = createCaller(await createAuthContext(userId));
    await caller.users["me.updatePreferences"]({ apiKeys: { [provider]: "sk-old" } });
    await caller.users["me.updatePreferences"]({ apiKeys: { [provider]: "sk-new" } });

    expect((await getUserApiKeys(userId))[provider]).toBe("sk-new");
  });

  it("clears the key when set to an empty string", async () => {
    const userId = await createTestUser();
    const caller = createCaller(await createAuthContext(userId));
    await caller.users["me.updatePreferences"]({ apiKeys: { [provider]: "sk-test-key" } });

    const cleared = await caller.users["me.updatePreferences"]({ apiKeys: { [provider]: "" } });
    expect(cleared.apiKeyProviders).toEqual([]);
    expect((await getUserApiKeys(userId))[provider]).toBeUndefined();
  });
});

it("leaves other providers' keys alone", async () => {
  const userId = await createTestUser();
  const caller = createCaller(await createAuthContext(userId));
  await caller.users["me.updatePreferences"]({ apiKeys: { groq: "gsk-a", openrouter: "sk-b" } });

  await caller.users["me.updatePreferences"]({ apiKeys: { groq: "" } });

  expect(await getUserApiKeys(userId)).toEqual({ openrouter: "sk-b" });
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

  it("are unavailable without an OpenRouter or DeepInfra key", async () => {
    const userId = await createTestUser();
    const caller = createCaller(await createAuthContext(userId));

    expect((await caller.narration.listVoiceModels()).models).toEqual([]);
  });
});

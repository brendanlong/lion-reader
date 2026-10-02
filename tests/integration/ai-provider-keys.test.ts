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
import { AI_PROVIDER_ENV_KEYS } from "../../src/server/services/ai-providers";
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

describe("without server keys", () => {
  const serverKeys = Object.values(AI_PROVIDER_ENV_KEYS);
  const previous = Object.fromEntries(serverKeys.map((name) => [name, process.env[name]]));
  beforeAll(() => {
    for (const name of serverKeys) delete process.env[name];
  });
  afterAll(() => {
    for (const name of serverKeys) {
      if (previous[name] !== undefined) process.env[name] = previous[name];
    }
  });

  it("makes AI features available with only a user key", async () => {
    const userId = await createTestUser();
    const caller = createCaller(await createAuthContext(userId));
    expect((await caller.summarization.isAvailable()).available).toBe(false);
    expect((await caller.narration.isAiTextProcessingAvailable()).available).toBe(false);

    await caller.users["me.updatePreferences"]({ apiKeys: { groq: "gsk-a" } });

    expect((await caller.summarization.isAvailable()).available).toBe(true);
    expect((await caller.narration.isAiTextProcessingAvailable()).available).toBe(true);
  });

  it("has no cloud voices without a cloud voice provider key", async () => {
    const userId = await createTestUser();
    const caller = createCaller(await createAuthContext(userId));

    expect((await caller.narration.listVoiceModels()).models).toEqual([]);
  });
});

describe("key input", () => {
  it("trims a pasted key", async () => {
    const userId = await createTestUser();
    const caller = createCaller(await createAuthContext(userId));

    await caller.users["me.updatePreferences"]({ apiKeys: { groq: "  gsk-padded\n" } });

    expect((await getUserApiKeys(userId)).groq).toBe("gsk-padded");
  });

  it("clears the key when given only whitespace", async () => {
    const userId = await createTestUser();
    const caller = createCaller(await createAuthContext(userId));
    await caller.users["me.updatePreferences"]({ apiKeys: { groq: "gsk-a" } });

    const cleared = await caller.users["me.updatePreferences"]({ apiKeys: { groq: "  \n" } });

    expect(cleared.apiKeyProviders).toEqual([]);
    expect((await getUserApiKeys(userId)).groq).toBeUndefined();
  });

  it("rejects an overlong model id", async () => {
    const userId = await createTestUser();
    const caller = createCaller(await createAuthContext(userId));
    const model = `groq:${"x".repeat(200)}`;

    await expect(
      caller.users["me.updatePreferences"]({ summarizationModel: model })
    ).rejects.toThrow();
    await expect(caller.users["me.updatePreferences"]({ narrationModel: model })).rejects.toThrow();
  });
});

it("skips a key that no longer decrypts and keeps the rest", async () => {
  // E.g. after API_KEY_ENCRYPTION_KEY is rotated: one unreadable key must not
  // take every AI feature down for the user.
  const userId = await createTestUser();
  const caller = createCaller(await createAuthContext(userId));
  await caller.users["me.updatePreferences"]({ apiKeys: { groq: "gsk-old" } });

  const rotatedFrom = process.env.API_KEY_ENCRYPTION_KEY;
  process.env.API_KEY_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  try {
    await caller.users["me.updatePreferences"]({ apiKeys: { openrouter: "sk-new" } });

    expect(await getUserApiKeys(userId)).toEqual({ openrouter: "sk-new" });
  } finally {
    process.env.API_KEY_ENCRYPTION_KEY = rotatedFrom;
  }
});

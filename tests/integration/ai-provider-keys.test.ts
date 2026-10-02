/**
 * Integration tests for per-user AI provider API keys: stored encrypted,
 * exposed to the client only as which providers have one, and decrypted on
 * demand.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "../../src/server/db";
import { userApiKeys } from "../../src/server/db/schema";
import { createCaller } from "../../src/server/trpc/root";
import { getUserApiKeys } from "../../src/server/auth/session";
import { AI_PROVIDER_ENV_KEYS } from "../../src/server/services/ai-providers";
import { UNREADABLE_API_KEY } from "../../src/server/services/unreadable-api-key";
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
});

describe("a saved key that no longer decrypts", () => {
  // E.g. after API_KEY_ENCRYPTION_KEY is rotated.
  let savedUnder: string | undefined;
  beforeEach(() => {
    savedUnder = process.env.API_KEY_ENCRYPTION_KEY;
  });
  afterEach(() => {
    process.env.API_KEY_ENCRYPTION_KEY = savedUnder;
  });

  it("is marked unreadable, leaving the user's other keys working", async () => {
    const userId = await createTestUser();
    const caller = createCaller(await createAuthContext(userId));
    await caller.users["me.updatePreferences"]({ apiKeys: { groq: "gsk-old" } });

    process.env.API_KEY_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    const updated = await caller.users["me.updatePreferences"]({
      apiKeys: { openrouter: "sk-new" },
    });

    expect(await getUserApiKeys(userId)).toEqual({
      groq: UNREADABLE_API_KEY,
      openrouter: "sk-new",
    });
    // Settings asks for it again, and the row is kept for a fixed encryption key.
    expect(updated.apiKeyProviders).toEqual(["groq", "openrouter"]);
    expect(updated.unreadableApiKeyProviders).toEqual(["groq"]);

    process.env.API_KEY_ENCRYPTION_KEY = savedUnder;
    expect((await getUserApiKeys(userId)).groq).toBe("gsk-old");
  });

  it("is readable again once re-entered", async () => {
    const userId = await createTestUser();
    const caller = createCaller(await createAuthContext(userId));
    await caller.users["me.updatePreferences"]({ apiKeys: { groq: "gsk-old" } });
    process.env.API_KEY_ENCRYPTION_KEY = randomBytes(32).toString("base64");

    const updated = await caller.users["me.updatePreferences"]({ apiKeys: { groq: "gsk-new" } });

    expect(updated.unreadableApiKeyProviders).toEqual([]);
    expect((await getUserApiKeys(userId)).groq).toBe("gsk-new");
  });

  it("doesn't stop preferences loading when the encryption key is missing or malformed", async () => {
    // Every page load prefetches preferences; a server-side misconfiguration
    // must not take the app down with it.
    const userId = await createTestUser();
    const caller = createCaller(await createAuthContext(userId));
    await caller.users["me.updatePreferences"]({ apiKeys: { groq: "gsk-old" } });

    delete process.env.API_KEY_ENCRYPTION_KEY;
    const unset = await caller.users["me.preferences"]();
    expect(unset.canConfigureApiKeys).toBe(false);
    expect(unset.apiKeyProviders).toEqual(["groq"]);
    expect(unset.unreadableApiKeyProviders).toEqual([]);

    process.env.API_KEY_ENCRYPTION_KEY = randomBytes(16).toString("base64");
    expect((await caller.users["me.preferences"]()).unreadableApiKeyProviders).toEqual([]);
  });

  it("is a loud failure when the encryption key itself is misconfigured", async () => {
    const userId = await createTestUser();
    const caller = createCaller(await createAuthContext(userId));
    await caller.users["me.updatePreferences"]({ apiKeys: { groq: "gsk-old" } });

    process.env.API_KEY_ENCRYPTION_KEY = randomBytes(16).toString("base64");
    await expect(getUserApiKeys(userId)).rejects.toThrow("must be 32 bytes");
    delete process.env.API_KEY_ENCRYPTION_KEY;
    await expect(getUserApiKeys(userId)).rejects.toThrow("API_KEY_ENCRYPTION_KEY is required");
  });
});

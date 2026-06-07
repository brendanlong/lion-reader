/**
 * Integration tests for API token scope enforcement in tRPC.
 *
 * Verifies that scoped API tokens are restricted to the endpoints their scope
 * grants (the MCP tool surface for `mcp`, saving for `saved:write`), while
 * account-management / non-MCP endpoints are session-only. Browser sessions
 * retain full access.
 *
 * See issue #870: scoped tokens previously got a full-access synthetic session.
 */

import { describe, it, expect, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/server/db";
import { users } from "../../src/server/db/schema";
import { generateUuidv7 } from "../../src/lib/uuidv7";
import { createCaller } from "../../src/server/trpc/root";
import type { Context } from "../../src/server/trpc/context";
import type { ApiTokenScope } from "../../src/server/auth/api-token";
import { TRPCError } from "@trpc/server";

const createdUserIds: string[] = [];

async function createTestUser(): Promise<string> {
  const userId = generateUuidv7();
  await db.insert(users).values({
    id: userId,
    email: `scope-${userId}@test.com`,
    passwordHash: "test-hash",
    tosAgreedAt: new Date(),
    privacyPolicyAgreedAt: new Date(),
    notEuAgreedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  createdUserIds.push(userId);
  return userId;
}

function buildSession(userId: string): NonNullable<Context["session"]> {
  const now = new Date();
  return {
    session: {
      id: generateUuidv7(),
      userId,
      tokenHash: "test-hash",
      userAgent: null,
      ipAddress: null,
      createdAt: now,
      expiresAt: new Date(Date.now() + 3600000),
      revokedAt: null,
      lastActiveAt: now,
    },
    user: {
      id: userId,
      email: `${userId}@test.com`,
      emailVerifiedAt: null,
      tosAgreedAt: now,
      privacyPolicyAgreedAt: now,
      notEuAgreedAt: now,
      passwordHash: "test-hash",
      inviteId: null,
      showSpam: false,
      groqApiKey: null,
      anthropicApiKey: null,
      summarizationModel: null,
      summarizationMaxWords: null,
      summarizationPrompt: null,
      createdAt: now,
      updatedAt: now,
    },
    hasGroqApiKey: false,
    hasAnthropicApiKey: false,
  };
}

function createSessionContext(userId: string): Context {
  return {
    db,
    session: buildSession(userId),
    apiToken: null,
    authType: "session",
    scopes: [],
    sessionToken: "test-token",
    headers: new Headers(),
  };
}

function createTokenContext(userId: string, scopes: ApiTokenScope[]): Context {
  return {
    db,
    // Synthetic session (matches what createContext builds for API tokens).
    session: buildSession(userId),
    apiToken: null,
    authType: "api_token",
    scopes,
    sessionToken: "test-token",
    headers: new Headers(),
  };
}

async function expectForbidden(promise: Promise<unknown>): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code: "FORBIDDEN" });
  // Sanity-check it's actually a TRPCError, not some other rejection.
  await promise.catch((err) => {
    expect(err).toBeInstanceOf(TRPCError);
  });
}

afterAll(async () => {
  for (const userId of createdUserIds) {
    await db.delete(users).where(eq(users.id, userId));
  }
});

describe("API token scope enforcement", () => {
  describe("mcp-scoped token", () => {
    it("can access MCP-surface endpoints (entries.list, tags.list)", async () => {
      const userId = await createTestUser();
      const caller = createCaller(createTokenContext(userId, ["mcp"]));

      await expect(caller.entries.list({})).resolves.toBeDefined();
      await expect(caller.tags.list()).resolves.toBeDefined();
    });

    it("cannot access session-only endpoints (sessions, narration)", async () => {
      const userId = await createTestUser();
      const caller = createCaller(createTokenContext(userId, ["mcp"]));

      await expectForbidden(caller.users["me.sessions"]());
      await expectForbidden(caller.narration.isAiTextProcessingAvailable());
    });
  });

  describe("saved:write-only token", () => {
    it("cannot access mcp-scoped endpoints", async () => {
      const userId = await createTestUser();
      const caller = createCaller(createTokenContext(userId, ["saved:write"]));

      await expectForbidden(caller.entries.list({}));
      await expectForbidden(caller.tags.list());
    });
  });

  describe("token with no scopes", () => {
    it("cannot access mcp-scoped endpoints", async () => {
      const userId = await createTestUser();
      const caller = createCaller(createTokenContext(userId, []));

      await expectForbidden(caller.entries.list({}));
    });
  });

  describe("browser session", () => {
    it("retains full access to both mcp-surface and session-only endpoints", async () => {
      const userId = await createTestUser();
      const caller = createCaller(createSessionContext(userId));

      await expect(caller.entries.list({})).resolves.toBeDefined();
      await expect(caller.users["me.sessions"]()).resolves.toBeDefined();
      await expect(caller.narration.isAiTextProcessingAvailable()).resolves.toBeDefined();
    });
  });
});

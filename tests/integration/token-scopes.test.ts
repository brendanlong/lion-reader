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

function createAnonymousContext(): Context {
  return {
    db,
    session: null,
    apiToken: null,
    authType: null,
    scopes: [],
    sessionToken: null,
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

/**
 * Asserts the promise rejects with a non-FORBIDDEN TRPCError code, which proves
 * the scope gate let the request through (it failed later, e.g. on input
 * validation or a missing record, not on authorization).
 */
async function expectPassedScopeGate(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code });
  expect(code).not.toBe("FORBIDDEN");
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

  describe("saved-article endpoints (any-of scope behavior)", () => {
    // saved.save accepts saved:write OR mcp. We use an invalid URL so the call
    // fails input validation (BAD_REQUEST) *after* the scope gate, proving the
    // gate allowed the request without performing a real network fetch.
    it("saved.save accepts both saved:write and mcp tokens", async () => {
      const writeUser = await createTestUser();
      const mcpUser = await createTestUser();
      const writeCaller = createCaller(createTokenContext(writeUser, ["saved:write"]));
      const mcpCaller = createCaller(createTokenContext(mcpUser, ["mcp"]));

      await expectPassedScopeGate(writeCaller.saved.save({ url: "not-a-url" }), "BAD_REQUEST");
      await expectPassedScopeGate(mcpCaller.saved.save({ url: "not-a-url" }), "BAD_REQUEST");
    });

    it("saved.save rejects a token with no scopes", async () => {
      const userId = await createTestUser();
      const caller = createCaller(createTokenContext(userId, []));

      await expectForbidden(caller.saved.save({ url: "not-a-url" }));
    });

    // saved.delete requires the mcp scope. A non-existent id yields NOT_FOUND for
    // an mcp token (gate passed) but FORBIDDEN for a saved:write-only token.
    it("saved.delete requires mcp; saved:write is rejected", async () => {
      const mcpUser = await createTestUser();
      const writeUser = await createTestUser();
      const mcpCaller = createCaller(createTokenContext(mcpUser, ["mcp"]));
      const writeCaller = createCaller(createTokenContext(writeUser, ["saved:write"]));

      await expectPassedScopeGate(mcpCaller.saved.delete({ id: generateUuidv7() }), "NOT_FOUND");
      await expectForbidden(writeCaller.saved.delete({ id: generateUuidv7() }));
    });
  });

  describe("feeds.preview / feeds.discover", () => {
    // These trigger outbound fetches, so they require a confirmed session (see
    // issue #951): anonymous or token access would be a scanning/amplification
    // primitive. Both rejections happen at the auth gate, before any fetch.
    it("rejects unauthenticated callers", async () => {
      const caller = createCaller(createAnonymousContext());

      await expect(
        caller.feeds.preview({ url: "https://example.com/feed.xml" })
      ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
      await expect(caller.feeds.discover({ url: "https://example.com/" })).rejects.toMatchObject({
        code: "UNAUTHORIZED",
      });
    });

    it("rejects API tokens (session-only)", async () => {
      const userId = await createTestUser();
      const caller = createCaller(createTokenContext(userId, ["mcp"]));

      await expectForbidden(caller.feeds.preview({ url: "https://example.com/feed.xml" }));
      await expectForbidden(caller.feeds.discover({ url: "https://example.com/" }));
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

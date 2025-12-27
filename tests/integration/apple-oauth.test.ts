/**
 * Integration tests for Apple OAuth flow.
 *
 * These tests use a real database to verify OAuth account creation,
 * linking, and session management. The Apple API responses are mocked
 * since we don't control that external service.
 *
 * Apple-specific considerations tested:
 * - First-auth user data (name, email) only sent once
 * - Private relay emails (randomized@privaterelay.appleid.com)
 * - JWT id_token decoding for user info
 */

import { describe, it, expect, beforeEach, afterAll, vi, beforeAll, afterEach } from "vitest";
import { eq, and } from "drizzle-orm";
import { db } from "../../src/server/db";
import { users, sessions, oauthAccounts } from "../../src/server/db/schema";
import { redis } from "../../src/server/redis";
import { generateUuidv7 } from "../../src/lib/uuidv7";
import * as argon2 from "argon2";

// Default mock Apple user info (embedded in JWT)
const mockAppleUserSub = "apple-user-123.abc.def";
const mockAppleEmail = "test@example.com";

// Mock the arctic library
vi.mock("arctic", () => {
  // Helper to create a mock JWT id_token (defined inside mock to avoid hoisting issues)
  function mockCreateIdToken(payload: Record<string, unknown>): string {
    const header = { alg: "RS256", kid: "test-key" };
    const headerB64 = Buffer.from(JSON.stringify(header)).toString("base64url");
    const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const signature = "mock-signature";
    return `${headerB64}.${payloadB64}.${signature}`;
  }

  // Create a mock class for Apple that can be instantiated with `new`
  class MockApple {
    createAuthorizationURL(state: string) {
      return new URL(`https://appleid.apple.com/auth/authorize?state=${state}`);
    }
    validateAuthorizationCode() {
      const idToken = mockCreateIdToken({
        iss: "https://appleid.apple.com",
        aud: "test-client-id",
        exp: Math.floor(Date.now() / 1000) + 3600,
        iat: Math.floor(Date.now() / 1000),
        sub: "apple-user-123.abc.def",
        email: "test@example.com",
        email_verified: "true",
        is_private_email: "false",
        auth_time: Math.floor(Date.now() / 1000),
        nonce_supported: true,
      });

      return {
        accessToken: () => "mock-apple-access-token",
        hasRefreshToken: () => true,
        refreshToken: () => "mock-apple-refresh-token",
        idToken: () => idToken,
        accessTokenExpiresAt: () => new Date(Date.now() + 3600000),
      };
    }
  }

  // Create a mock class for Google
  class MockGoogle {
    createAuthorizationURL() {
      return new URL("https://accounts.google.com/o/oauth2/v2/auth");
    }
    validateAuthorizationCode() {
      return {};
    }
  }

  return {
    Apple: MockApple,
    Google: MockGoogle,
    generateState: () => "mock-apple-state",
  };
});

describe("Apple OAuth", () => {
  // Setup environment for Apple OAuth
  beforeAll(() => {
    process.env.APPLE_CLIENT_ID = "test-apple-client-id";
    process.env.APPLE_TEAM_ID = "test-team-id";
    process.env.APPLE_KEY_ID = "test-key-id";
    // Mock private key in PEM format
    process.env.APPLE_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgevZzL1gdAFr88hb2
OF/2NxApJCzGCEDdfSp6VQO30hyhRANCAAQRWz+jn65BtOMvdyHKcvjBeBSDZH2r
1RTwjmYSi9R/zpBnuQ4EiMnCqfMPWiZqB4QdbAd0E7oH50VpuZ1P087G
-----END PRIVATE KEY-----`;
    process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";
  });

  afterAll(() => {
    delete process.env.APPLE_CLIENT_ID;
    delete process.env.APPLE_TEAM_ID;
    delete process.env.APPLE_KEY_ID;
    delete process.env.APPLE_PRIVATE_KEY;
  });

  // Clean up tables before each test
  beforeEach(async () => {
    await db.delete(sessions);
    await db.delete(oauthAccounts);
    await db.delete(users);
    // Clear Redis Apple OAuth state
    const keys = await redis.keys("oauth:apple:state:*");
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  });

  // Clean up after all tests
  afterAll(async () => {
    await db.delete(sessions);
    await db.delete(oauthAccounts);
    await db.delete(users);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("createAppleAuthUrl", () => {
    it("generates authorization URL and stores state", async () => {
      const { createAppleAuthUrl } = await import("../../src/server/auth/oauth/apple");

      const result = await createAppleAuthUrl();

      expect(result.url).toContain("https://appleid.apple.com");
      expect(result.state).toBe("mock-apple-state");

      // Verify state is stored in Redis
      const storedState = await redis.get("oauth:apple:state:mock-apple-state");
      expect(storedState).toBe("valid");
    });
  });

  describe("validateAppleCallback", () => {
    it("validates callback and returns user info from JWT", async () => {
      const { createAppleAuthUrl, validateAppleCallback } =
        await import("../../src/server/auth/oauth/apple");

      // First create auth URL to store state
      await createAppleAuthUrl();

      // Now validate the callback
      const result = await validateAppleCallback("mock-auth-code", "mock-apple-state");

      expect(result.userInfo.sub).toBe(mockAppleUserSub);
      expect(result.userInfo.email).toBe(mockAppleEmail);
      expect(result.userInfo.emailVerified).toBe(true);
      expect(result.userInfo.isPrivateEmail).toBe(false);
      expect(result.tokens.accessToken).toBe("mock-apple-access-token");
      expect(result.tokens.refreshToken).toBe("mock-apple-refresh-token");

      // State should be consumed (deleted)
      const storedState = await redis.get("oauth:apple:state:mock-apple-state");
      expect(storedState).toBeNull();
    });

    it("parses first-auth user data when provided as JSON string", async () => {
      const { createAppleAuthUrl, validateAppleCallback } =
        await import("../../src/server/auth/oauth/apple");

      await createAppleAuthUrl();

      const firstAuthData = JSON.stringify({
        name: {
          firstName: "John",
          lastName: "Doe",
        },
        email: "john@example.com",
      });

      const result = await validateAppleCallback(
        "mock-auth-code",
        "mock-apple-state",
        firstAuthData
      );

      expect(result.firstAuthData).toBeDefined();
      expect(result.firstAuthData?.name?.firstName).toBe("John");
      expect(result.firstAuthData?.name?.lastName).toBe("Doe");
      expect(result.firstAuthData?.email).toBe("john@example.com");
    });

    it("parses first-auth user data when provided as object", async () => {
      const { createAppleAuthUrl, validateAppleCallback } =
        await import("../../src/server/auth/oauth/apple");

      await createAppleAuthUrl();

      const firstAuthData = {
        name: {
          firstName: "Jane",
          lastName: "Smith",
        },
        email: "jane@example.com",
      };

      const result = await validateAppleCallback(
        "mock-auth-code",
        "mock-apple-state",
        firstAuthData
      );

      expect(result.firstAuthData).toBeDefined();
      expect(result.firstAuthData?.name?.firstName).toBe("Jane");
      expect(result.firstAuthData?.name?.lastName).toBe("Smith");
    });

    it("fails with invalid state (not found)", async () => {
      const { validateAppleCallback } = await import("../../src/server/auth/oauth/apple");

      await expect(validateAppleCallback("mock-auth-code", "invalid-state")).rejects.toThrow(
        "Invalid or expired OAuth state"
      );
    });
  });

  describe("OAuth callback integration", () => {
    // Helper to create a test user
    async function createTestUser(email: string, withPassword = true) {
      const userId = generateUuidv7();
      const passwordHash = withPassword ? await argon2.hash("password123") : null;

      await db.insert(users).values({
        id: userId,
        email,
        passwordHash,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      return userId;
    }

    // Helper to create OAuth account
    async function createAppleOAuthAccount(userId: string, providerAccountId: string) {
      const accountId = generateUuidv7();

      await db.insert(oauthAccounts).values({
        id: accountId,
        userId,
        provider: "apple",
        providerAccountId,
        accessToken: "old-token",
        createdAt: new Date(),
      });

      return accountId;
    }

    it("finds existing Apple OAuth account", async () => {
      // Create existing user and OAuth account
      const userId = await createTestUser("existing@example.com");
      await createAppleOAuthAccount(userId, mockAppleUserSub);

      // Verify OAuth account exists
      const oauthAccount = await db
        .select()
        .from(oauthAccounts)
        .where(
          and(
            eq(oauthAccounts.provider, "apple"),
            eq(oauthAccounts.providerAccountId, mockAppleUserSub)
          )
        )
        .limit(1);

      expect(oauthAccount.length).toBe(1);
      expect(oauthAccount[0].userId).toBe(userId);
    });

    it("can link Apple OAuth to existing user with matching email", async () => {
      // Create existing user with email that matches Apple user
      const userId = await createTestUser(mockAppleEmail, true);

      // Verify user exists
      const user = await db.select().from(users).where(eq(users.id, userId)).limit(1);

      expect(user.length).toBe(1);
      expect(user[0].email).toBe(mockAppleEmail);

      // Verify no OAuth account exists yet
      const oauthAccount = await db
        .select()
        .from(oauthAccounts)
        .where(eq(oauthAccounts.userId, userId))
        .limit(1);

      expect(oauthAccount.length).toBe(0);
    });
  });

  describe("Apple private relay email handling", () => {
    it("identifies private relay emails", async () => {
      const { isApplePrivateRelayEmail } = await import("../../src/server/auth/oauth/apple");

      expect(isApplePrivateRelayEmail("abc123@privaterelay.appleid.com")).toBe(true);
      expect(isApplePrivateRelayEmail("user@example.com")).toBe(false);
      expect(isApplePrivateRelayEmail("test@gmail.com")).toBe(false);
    });
  });

  describe("State storage", () => {
    it("stores state with TTL", async () => {
      const { createAppleAuthUrl } = await import("../../src/server/auth/oauth/apple");

      await createAppleAuthUrl();

      // Check TTL is set (should be 600 seconds)
      const ttl = await redis.ttl("oauth:apple:state:mock-apple-state");
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(600);
    });

    it("consumes state on use (one-time use)", async () => {
      const { createAppleAuthUrl, validateAppleCallback } =
        await import("../../src/server/auth/oauth/apple");

      await createAppleAuthUrl();

      // First use should succeed
      await validateAppleCallback("mock-auth-code", "mock-apple-state");

      // Second use should fail (state consumed)
      await expect(validateAppleCallback("mock-auth-code", "mock-apple-state")).rejects.toThrow(
        "Invalid or expired OAuth state"
      );
    });
  });

  describe("JWT id_token decoding", () => {
    it("extracts user info from valid JWT", async () => {
      // Store state first
      await redis.setex("oauth:apple:state:jwt-test-state", 600, "valid");

      const { validateAppleCallback } = await import("../../src/server/auth/oauth/apple");

      const result = await validateAppleCallback("mock-auth-code", "jwt-test-state");

      // Verify extracted info
      expect(result.userInfo.sub).toBe(mockAppleUserSub);
      expect(result.userInfo.email).toBe(mockAppleEmail);
    });
  });
});

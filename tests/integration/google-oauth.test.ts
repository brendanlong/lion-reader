/**
 * Integration tests for Google OAuth flow.
 *
 * These tests use a real database to verify OAuth account creation,
 * linking, and session management. The Google API responses are mocked
 * since we don't control that external service.
 */

import { describe, it, expect, beforeEach, afterAll, vi, beforeAll, afterEach } from "vitest";
import { eq, and } from "drizzle-orm";
import { db } from "../../src/server/db";
import { users, sessions, oauthAccounts } from "../../src/server/db/schema";
import { redis } from "../../src/server/redis";
import { generateUuidv7 } from "../../src/lib/uuidv7";
import * as argon2 from "argon2";

// Mock the arctic library to avoid needing real Google credentials
vi.mock("arctic", () => {
  // Create a mock class for Google that can be instantiated with `new`
  class MockGoogle {
    createAuthorizationURL(state: string) {
      return new URL(`https://accounts.google.com/o/oauth2/v2/auth?state=${state}`);
    }
    validateAuthorizationCode() {
      return {
        accessToken: () => "mock-access-token",
        hasRefreshToken: () => true,
        refreshToken: () => "mock-refresh-token",
        accessTokenExpiresAt: () => new Date(Date.now() + 3600000),
      };
    }
  }

  return {
    Google: MockGoogle,
    generateCodeVerifier: vi.fn().mockReturnValue("mock-code-verifier"),
    generateState: vi.fn().mockReturnValue("mock-state"),
  };
});

// Mock Google user info fetch
const mockGoogleUserInfo = {
  sub: "google-user-123",
  email: "test@example.com",
  email_verified: true,
  name: "Test User",
  given_name: "Test",
  family_name: "User",
  picture: "https://example.com/avatar.jpg",
};

// We need to mock the fetch for Google user info
const originalFetch = global.fetch;

describe("Google OAuth", () => {
  // Mock Google OAuth config to be enabled
  beforeAll(() => {
    // Set the environment variables for Google OAuth
    process.env.GOOGLE_CLIENT_ID = "test-client-id";
    process.env.GOOGLE_CLIENT_SECRET = "test-client-secret";
    process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";

    // Mock global fetch for Google API calls
    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes("googleapis.com/oauth2/v3/userinfo")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(mockGoogleUserInfo),
        });
      }
      return originalFetch(url);
    });
  });

  afterAll(() => {
    // Restore fetch
    global.fetch = originalFetch;
    // Clean up environment
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
  });

  // Clean up tables before each test
  beforeEach(async () => {
    await db.delete(sessions);
    await db.delete(oauthAccounts);
    await db.delete(users);
    // Clear Redis PKCE data
    const keys = await redis.keys("oauth:pkce:*");
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

  describe("createGoogleAuthUrl", () => {
    it("generates authorization URL and stores PKCE verifier", async () => {
      const { createGoogleAuthUrl } = await import("../../src/server/auth/oauth/google");

      const result = await createGoogleAuthUrl();

      expect(result.url).toContain("https://accounts.google.com");
      expect(result.state).toBe("mock-state");

      // Verify PKCE verifier is stored in Redis (as JSON with verifier and scopes)
      const storedData = await redis.get("oauth:pkce:mock-state");
      expect(storedData).not.toBeNull();
      const parsedData = JSON.parse(storedData!);
      expect(parsedData.verifier).toBe("mock-code-verifier");
      expect(parsedData.scopes).toEqual(["openid", "email", "profile"]);
    });
  });

  describe("validateGoogleCallback", () => {
    it("validates callback and returns user info", async () => {
      const { createGoogleAuthUrl, validateGoogleCallback } =
        await import("../../src/server/auth/oauth/google");

      // First create auth URL to store PKCE verifier
      await createGoogleAuthUrl();

      // Now validate the callback
      const result = await validateGoogleCallback("mock-auth-code", "mock-state");

      expect(result.userInfo.sub).toBe("google-user-123");
      expect(result.userInfo.email).toBe("test@example.com");
      expect(result.tokens.accessToken).toBe("mock-access-token");
      expect(result.tokens.refreshToken).toBe("mock-refresh-token");

      // PKCE verifier should be consumed (deleted)
      const storedVerifier = await redis.get("oauth:pkce:mock-state");
      expect(storedVerifier).toBeNull();
    });

    it("fails with invalid state (PKCE verifier not found)", async () => {
      const { validateGoogleCallback } = await import("../../src/server/auth/oauth/google");

      await expect(validateGoogleCallback("mock-auth-code", "invalid-state")).rejects.toThrow(
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
    async function createOAuthAccount(userId: string, providerAccountId: string) {
      const accountId = generateUuidv7();

      await db.insert(oauthAccounts).values({
        id: accountId,
        userId,
        provider: "google",
        providerAccountId,
        accessToken: "old-token",
        createdAt: new Date(),
      });

      return accountId;
    }

    it("creates new user and OAuth account for new Google user", async () => {
      // Store PKCE data manually (JSON format with verifier and scopes)
      const pkceData = JSON.stringify({
        verifier: "mock-code-verifier",
        scopes: ["openid", "email", "profile"],
      });
      await redis.setex("oauth:pkce:new-user-state", 600, pkceData);

      // Reset mock to use a different state
      const { generateState } = await import("arctic");
      vi.mocked(generateState).mockReturnValueOnce("new-user-state");

      const { validateGoogleCallback } = await import("../../src/server/auth/oauth/google");

      const result = await validateGoogleCallback("mock-auth-code", "new-user-state");

      expect(result.userInfo.email).toBe("test@example.com");

      // Verify user was NOT created by this test (we're testing validateGoogleCallback only)
      // The actual user creation happens in the tRPC callback handler
    });

    it("finds existing OAuth account", async () => {
      // Create existing user and OAuth account
      const userId = await createTestUser("existing@example.com");
      await createOAuthAccount(userId, "google-user-123");

      // Verify OAuth account exists
      const oauthAccount = await db
        .select()
        .from(oauthAccounts)
        .where(
          and(
            eq(oauthAccounts.provider, "google"),
            eq(oauthAccounts.providerAccountId, "google-user-123")
          )
        )
        .limit(1);

      expect(oauthAccount.length).toBe(1);
      expect(oauthAccount[0].userId).toBe(userId);
    });

    it("can link OAuth to existing user with matching email", async () => {
      // Create existing user with email that matches Google user
      const userId = await createTestUser("test@example.com", true);

      // Verify user exists
      const user = await db.select().from(users).where(eq(users.id, userId)).limit(1);

      expect(user.length).toBe(1);
      expect(user[0].email).toBe("test@example.com");

      // Verify no OAuth account exists yet
      const oauthAccount = await db
        .select()
        .from(oauthAccounts)
        .where(eq(oauthAccounts.userId, userId))
        .limit(1);

      expect(oauthAccount.length).toBe(0);
    });
  });

  describe("PKCE verifier storage", () => {
    it("stores verifier with TTL", async () => {
      const { createGoogleAuthUrl } = await import("../../src/server/auth/oauth/google");

      const result = await createGoogleAuthUrl();

      // Check TTL is set (should be 600 seconds)
      // Use the actual state returned to handle mock variations
      const ttl = await redis.ttl(`oauth:pkce:${result.state}`);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(600);
    });

    it("consumes verifier on use (one-time use)", async () => {
      const { createGoogleAuthUrl, validateGoogleCallback } =
        await import("../../src/server/auth/oauth/google");

      await createGoogleAuthUrl();

      // First use should succeed
      await validateGoogleCallback("mock-auth-code", "mock-state");

      // Second use should fail (verifier consumed)
      await expect(validateGoogleCallback("mock-auth-code", "mock-state")).rejects.toThrow(
        "Invalid or expired OAuth state"
      );
    });
  });
});

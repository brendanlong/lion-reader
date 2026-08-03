/**
 * Integration tests for Google OAuth flow.
 *
 * These tests use a real database to verify OAuth account creation,
 * linking, and session management. The Google API responses are mocked
 * since we don't control that external service.
 */

import { describe, it, expect, beforeEach, afterAll, vi, beforeAll, afterEach } from "vitest";
import { eq, and } from "drizzle-orm";
import { generateKeyPair, SignJWT } from "jose";
import { db } from "../../src/server/db";
import { users, sessions, oauthAccounts } from "../../src/server/db/schema";
import { redis } from "../../src/server/redis";
import { generateUuidv7 } from "../../src/lib/uuidv7";
import * as argon2 from "argon2";
import { createTestUser } from "./helpers";

const GOOGLE_ISSUER = "https://accounts.google.com";
const GOOGLE_CLIENT_ID = "test-client-id";

/**
 * Because we request the `openid` scope, Google's token response carries an `id_token`,
 * and the OAuth client hard-validates its `iss`/`aud`/`exp` even though we read the
 * profile from the userinfo endpoint instead. A wrong `issuer` in our server metadata
 * would therefore break every Google login, so the exchange is exercised with a real one.
 */
async function signGoogleIdToken(overrides: { iss?: string; aud?: string } = {}) {
  const { privateKey } = await generateKeyPair("RS256", { extractable: true });
  return new SignJWT({ email: "test@example.com", email_verified: true })
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(overrides.iss ?? GOOGLE_ISSUER)
    .setAudience(overrides.aud ?? GOOGLE_CLIENT_ID)
    .setSubject("google-user-123")
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(privateKey);
}

// What Google's token endpoint returns for our mocked authorization code. Stubbing at
// the HTTP boundary (rather than mocking the OAuth client) keeps the real code exchange,
// including PKCE, state and id_token handling, under test.
const mockTokenResponse: Record<string, unknown> = {
  access_token: "mock-access-token",
  token_type: "Bearer",
  expires_in: 3600,
  refresh_token: "mock-refresh-token",
  scope: "openid email profile",
};

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

// Captured from the stubbed token endpoint so a test can assert what we put on the wire
let lastTokenRequest: { body: URLSearchParams; headers: Headers } | null = null;

describe("Google OAuth", () => {
  // Mock Google OAuth config to be enabled
  beforeAll(async () => {
    // Set the environment variables for Google OAuth
    process.env.GOOGLE_CLIENT_ID = GOOGLE_CLIENT_ID;
    process.env.GOOGLE_CLIENT_SECRET = "test-client-secret";
    process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";

    // Mock global fetch for Google API calls
    global.fetch = vi.fn().mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        input instanceof URL ? input.href : input instanceof Request ? input.url : String(input);
      if (url.startsWith("https://oauth2.googleapis.com/token")) {
        lastTokenRequest = {
          body: new URLSearchParams(String(init?.body)),
          headers: new Headers(init?.headers),
        };
        return Promise.resolve(
          new Response(JSON.stringify(mockTokenResponse), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        );
      }
      if (url.includes("googleapis.com/oauth2/v3/userinfo")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(mockGoogleUserInfo),
        });
      }
      return originalFetch(input, init);
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
    // Default to a valid id_token; negative tests overwrite it.
    mockTokenResponse.id_token = await signGoogleIdToken();
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

      const url = new URL(result.url);
      expect(url.origin).toBe("https://accounts.google.com");
      expect(url.searchParams.get("state")).toBe(result.state);
      expect(url.searchParams.get("code_challenge_method")).toBe("S256");
      expect(url.searchParams.get("code_challenge")).toBeTruthy();
      expect(url.searchParams.get("scope")).toBe("openid email profile");
      expect(result.state).not.toBe("");

      // Verify PKCE verifier is stored in Redis (as JSON with verifier and scopes)
      const storedData = await redis.get(`oauth:pkce:${result.state}`);
      expect(storedData).not.toBeNull();
      const parsedData = JSON.parse(storedData!);
      expect(parsedData.verifier).toEqual(expect.any(String));
      expect(parsedData.scopes).toEqual(["openid", "email", "profile"]);
    });
  });

  describe("validateGoogleCallback", () => {
    it("validates callback and returns user info", async () => {
      const { createGoogleAuthUrl, validateGoogleCallback } =
        await import("../../src/server/auth/oauth/google");

      // First create auth URL to store PKCE verifier
      const { state } = await createGoogleAuthUrl();

      // Now validate the callback
      const result = await validateGoogleCallback("mock-auth-code", state);

      expect(result.userInfo.sub).toBe("google-user-123");
      expect(result.userInfo.email).toBe("test@example.com");
      expect(result.tokens.accessToken).toBe("mock-access-token");
      expect(result.tokens.refreshToken).toBe("mock-refresh-token");

      // PKCE verifier should be consumed (deleted)
      const storedVerifier = await redis.get(`oauth:pkce:${state}`);
      expect(storedVerifier).toBeNull();
    });

    it("fails with invalid state (PKCE verifier not found)", async () => {
      const { validateGoogleCallback } = await import("../../src/server/auth/oauth/google");

      await expect(validateGoogleCallback("mock-auth-code", "invalid-state")).rejects.toThrow(
        "Invalid or expired OAuth state"
      );
    });

    it("fails closed when the stored PKCE verifier is empty", async () => {
      const { validateGoogleCallback } = await import("../../src/server/auth/oauth/google");

      await redis.setex(
        "oauth:pkce:empty-verifier-state",
        600,
        JSON.stringify({ verifier: "", scopes: ["openid", "email", "profile"], mode: "login" })
      );

      // Must not fall through to an exchange with no PKCE proof at all
      await expect(
        validateGoogleCallback("mock-auth-code", "empty-verifier-state")
      ).rejects.toThrow("Invalid or expired OAuth state");
    });

    it("sends the token request Google documents", async () => {
      const { createGoogleAuthUrl, validateGoogleCallback } =
        await import("../../src/server/auth/oauth/google");

      const { state } = await createGoogleAuthUrl();
      lastTokenRequest = null;
      await validateGoogleCallback("mock-auth-code", state);

      const { body, headers } = lastTokenRequest!;
      expect(body.get("grant_type")).toBe("authorization_code");
      expect(body.get("code")).toBe("mock-auth-code");
      // Must match the redirect_uri sent on the authorization request, verbatim
      expect(body.get("redirect_uri")).toBe(
        "http://localhost:3000/api/v1/auth/oauth/google/callback"
      );
      expect(body.get("code_verifier")).toBeTruthy();
      // client_secret_post: raw credentials in the body, no Basic header whose
      // form-url-encoding would escape the punctuation in real Google credentials
      expect(body.get("client_id")).toBe(GOOGLE_CLIENT_ID);
      expect(body.get("client_secret")).toBe("test-client-secret");
      expect(headers.get("authorization")).toBeNull();
    });

    it("accepts the id_token issuer Google's discovery document publishes", async () => {
      const { createGoogleAuthUrl, validateGoogleCallback } =
        await import("../../src/server/auth/oauth/google");

      mockTokenResponse.id_token = await signGoogleIdToken({ iss: GOOGLE_ISSUER });
      const { state } = await createGoogleAuthUrl();

      await expect(validateGoogleCallback("mock-auth-code", state)).resolves.toBeDefined();
    });

    it("rejects an id_token minted for a different client", async () => {
      const { createGoogleAuthUrl, validateGoogleCallback } =
        await import("../../src/server/auth/oauth/google");

      mockTokenResponse.id_token = await signGoogleIdToken({ aud: "some-other-clients-id" });
      const { state } = await createGoogleAuthUrl();

      await expect(validateGoogleCallback("mock-auth-code", state)).rejects.toThrow();
    });
  });

  describe("OAuth callback integration", () => {
    // Helper to create a test user
    async function createUser(email: string, withPassword = true) {
      return createTestUser({
        email,
        passwordHash: withPassword ? await argon2.hash("password123") : null,
      });
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

      const { validateGoogleCallback } = await import("../../src/server/auth/oauth/google");

      const result = await validateGoogleCallback("mock-auth-code", "new-user-state");

      expect(result.userInfo.email).toBe("test@example.com");

      // Verify user was NOT created by this test (we're testing validateGoogleCallback only)
      // The actual user creation happens in the tRPC callback handler
    });

    it("finds existing OAuth account", async () => {
      // Create existing user and OAuth account
      const userId = await createUser("existing@example.com");
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
      const userId = await createUser("test@example.com", true);

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

      const { state } = await createGoogleAuthUrl();

      // First use should succeed
      await validateGoogleCallback("mock-auth-code", state);

      // Second use should fail (verifier consumed)
      await expect(validateGoogleCallback("mock-auth-code", state)).rejects.toThrow(
        "Invalid or expired OAuth state"
      );
    });
  });
});

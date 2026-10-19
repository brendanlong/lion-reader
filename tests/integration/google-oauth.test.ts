/**
 * Integration tests for Google OAuth flow.
 *
 * These tests use real Redis to verify authorization URL creation, callback
 * validation and PKCE verifier handling. The Google API responses are mocked
 * since we don't control that external service.
 */

import { describe, it, expect, beforeEach, afterAll, vi, beforeAll, afterEach } from "vitest";
import { generateKeyPair, SignJWT } from "jose";
import { db } from "../../src/server/db";
import { users, sessions, oauthAccounts } from "../../src/server/db/schema";
import { redis } from "../../src/server/redis";
import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import {
  OAUTH_STATE_COOKIE_NAME,
  OAUTH_STATE_TTL_SECONDS,
} from "../../src/server/auth/oauth/state-cookie";
import { createTestOAuthLink, createTestUser } from "./helpers";

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

// How Google's token response spells the sign-in scopes we request as "openid email profile"
const GOOGLE_GRANTED_SIGN_IN_SCOPE =
  "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile";

// What Google's token endpoint returns for our mocked authorization code. Stubbing at
// the HTTP boundary (rather than mocking the OAuth client) keeps the real code exchange,
// including PKCE, state and id_token handling, under test.
const mockTokenResponse: Record<string, unknown> = {
  access_token: "mock-access-token",
  token_type: "Bearer",
  expires_in: 3600,
  refresh_token: "mock-refresh-token",
  scope: GOOGLE_GRANTED_SIGN_IN_SCOPE,
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

/** Runs both halves of a callback: consume the state, then exchange the code. */
async function validateGoogleCallback(code: string, state: string) {
  const { beginGoogleCallback } = await import("../../src/server/auth/oauth/google");
  const pending = await beginGoogleCallback(state);
  return { flow: pending.flow, identity: await pending.complete(code) };
}

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

  async function cleanup(): Promise<void> {
    await db.delete(sessions);
    await db.delete(oauthAccounts);
    await db.delete(users);
  }

  beforeEach(async () => {
    // Default to a valid id_token; negative tests overwrite it.
    mockTokenResponse.id_token = await signGoogleIdToken();
    await cleanup();
    // Clear Redis PKCE data
    const keys = await redis.keys("oauth:pkce:*");
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  });

  // Clean up after all tests
  afterAll(cleanup);

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
      // So a plain sign-in's token keeps an earlier Docs/Drive grant (#1803)
      expect(url.searchParams.get("include_granted_scopes")).toBe("true");
      expect(result.state).not.toBe("");

      // Verify PKCE verifier is stored in Redis
      const storedData = await redis.get(`oauth:pkce:${result.state}`);
      expect(storedData).not.toBeNull();
      expect(JSON.parse(storedData!).verifier).toEqual(expect.any(String));
    });
  });

  describe("validateGoogleCallback", () => {
    it("validates callback and returns user info", async () => {
      const { createGoogleAuthUrl } = await import("../../src/server/auth/oauth/google");

      // First create auth URL to store PKCE verifier
      const { state } = await createGoogleAuthUrl();

      // Now validate the callback
      const result = await validateGoogleCallback("mock-auth-code", state);

      expect(result.flow).toEqual({ kind: "sign-in" });
      expect(result.identity).toMatchObject({
        providerAccountId: "google-user-123",
        email: "test@example.com",
        emailVerified: true,
        accessToken: "mock-access-token",
        refreshToken: "mock-refresh-token",
      });

      // PKCE verifier should be consumed (deleted)
      const storedVerifier = await redis.get(`oauth:pkce:${state}`);
      expect(storedVerifier).toBeNull();
    });

    it("reports the scopes Google granted, not just the ones requested (#1803)", async () => {
      const { createGoogleAuthUrl } = await import("../../src/server/auth/oauth/google");
      const { GOOGLE_DOCS_SCOPE } = await import("../../src/server/google/docs");

      const originalScope = mockTokenResponse.scope;
      mockTokenResponse.scope = `${GOOGLE_GRANTED_SIGN_IN_SCOPE} ${GOOGLE_DOCS_SCOPE}`;
      try {
        const { state } = await createGoogleAuthUrl();
        const result = await validateGoogleCallback("mock-auth-code", state);
        expect(result.identity.scopes).toEqual([
          ...GOOGLE_GRANTED_SIGN_IN_SCOPE.split(" "),
          GOOGLE_DOCS_SCOPE,
        ]);
      } finally {
        mockTokenResponse.scope = originalScope;
      }
    });

    it("fails with invalid state (PKCE verifier not found)", async () => {
      await expect(validateGoogleCallback("mock-auth-code", "invalid-state")).rejects.toThrow(
        "Invalid or expired OAuth state"
      );
    });

    it("fails closed when the stored PKCE verifier is empty", async () => {
      await redis.setex(
        "oauth:pkce:empty-verifier-state",
        600,
        JSON.stringify({ verifier: "", mode: "login" })
      );

      // Must not fall through to an exchange with no PKCE proof at all
      await expect(
        validateGoogleCallback("mock-auth-code", "empty-verifier-state")
      ).rejects.toThrow("Invalid or expired OAuth state");
    });

    it("sends the token request Google documents", async () => {
      const { createGoogleAuthUrl } = await import("../../src/server/auth/oauth/google");

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

    it("rejects an id_token minted for a different client", async () => {
      const { createGoogleAuthUrl } = await import("../../src/server/auth/oauth/google");

      mockTokenResponse.id_token = await signGoogleIdToken({ aud: "some-other-clients-id" });
      const { state } = await createGoogleAuthUrl();

      await expect(validateGoogleCallback("mock-auth-code", state)).rejects.toThrow();
    });
  });

  async function callback(state: string, { withStateCookie = true } = {}): Promise<Response> {
    const { GET } = await import("../../src/app/api/v1/auth/oauth/google/callback/route");
    return GET(
      new NextRequest(
        `http://localhost:3000/api/v1/auth/oauth/google/callback?code=mock-auth-code&state=${state}`,
        { headers: withStateCookie ? { cookie: `${OAUTH_STATE_COOKIE_NAME}=${state}` } : {} }
      )
    );
  }

  function locationOf(response: Response): string {
    const location = new URL(response.headers.get("location")!);
    return location.pathname + location.search;
  }

  it("signs the user in with a session cookie and clears the state cookie", async () => {
    const { createGoogleAuthUrl } = await import("../../src/server/auth/oauth/google");
    const { validateSession } = await import("../../src/server/auth/session");

    await createTestUser({ email: mockGoogleUserInfo.email });
    const { state } = await createGoogleAuthUrl();
    const response = await callback(state);

    expect(locationOf(response)).toBe("/auth/oauth/complete?redirect=%2Fall");
    const setCookies = response.headers.getSetCookie();
    const sessionCookie = setCookies.find((cookie) => cookie.startsWith("session="));
    expect(sessionCookie).toMatch(/HttpOnly/);
    const token = sessionCookie!.slice("session=".length).split(";")[0];
    const session = await validateSession(token);
    expect(session?.user.email).toBe(mockGoogleUserInfo.email);
    expect(setCookies.find((c) => c.startsWith(`${OAUTH_STATE_COOKIE_NAME}=`))).toMatch(
      /Max-Age=0/
    );
  });

  describe("return path (#2029)", () => {
    const returnPath = "/extension/save?url=https%3A%2F%2Fexample.com%2Fa";

    it("returns a signed-in user to it", async () => {
      const { createGoogleAuthUrl } = await import("../../src/server/auth/oauth/google");

      await createTestUser({ email: mockGoogleUserInfo.email });
      const { state } = await createGoogleAuthUrl({ returnPath });
      const response = await callback(state);

      expect(locationOf(response)).toBe(
        `/auth/oauth/complete?redirect=${encodeURIComponent(returnPath)}`
      );
    });

    it("never sends the user off-site", async () => {
      const { createGoogleAuthUrl } = await import("../../src/server/auth/oauth/google");

      await createTestUser({ email: mockGoogleUserInfo.email });
      const { state } = await createGoogleAuthUrl({ returnPath: "//evil.example" });
      const response = await callback(state);

      expect(locationOf(response)).toBe("/auth/oauth/complete?redirect=%2Fall");
    });

    it("carries it through signup confirmation for a new user", async () => {
      const { createGoogleAuthUrl } = await import("../../src/server/auth/oauth/google");

      vi.stubEnv("ALLOWED_PUBLIC_SIGNUP_PROVIDERS", "google");
      try {
        const { state } = await createGoogleAuthUrl({ returnPath });
        const response = await callback(state);

        const completeSignup = `/complete-signup?redirect=${encodeURIComponent(returnPath)}`;
        expect(locationOf(response)).toBe(
          `/auth/oauth/complete?redirect=${encodeURIComponent(completeSignup)}`
        );
      } finally {
        vi.unstubAllEnvs();
      }
    });
  });

  describe("state cookie (#1263)", () => {
    it("rejects a sign-in callback from a browser that didn't start the flow", async () => {
      const { createGoogleAuthUrl } = await import("../../src/server/auth/oauth/google");

      const { state } = await createGoogleAuthUrl();
      lastTokenRequest = null;
      const response = await callback(state, { withStateCookie: false });

      expect(locationOf(response)).toBe("/login?error=invalid_state");
      expect(response.headers.get("set-cookie") ?? "").not.toMatch(/(^|[ ,])session=/);
      // Rejected before the code is exchanged
      expect(lastTokenRequest).toBeNull();
      expect(await db.select().from(users)).toHaveLength(0);
    });

    it("doesn't let a callback without the cookie burn the state for its owner", async () => {
      const { createGoogleAuthUrl } = await import("../../src/server/auth/oauth/google");

      const userId = await createTestUser();
      await createTestOAuthLink(userId, "google", { providerAccountId: mockGoogleUserInfo.sub });
      const { state } = await createGoogleAuthUrl();

      const attack = await callback(state, { withStateCookie: false });
      expect(locationOf(attack)).toBe("/login?error=invalid_state");

      const response = await callback(state);
      expect(locationOf(response)).toBe(
        `/auth/oauth/complete?redirect=${encodeURIComponent("/all")}`
      );
      expect(response.headers.get("set-cookie") ?? "").toMatch(/(^|[ ,])session=/);
    });

    it("lets extension-save through without one, since its page can't set it", async () => {
      const { createGoogleAuthUrl } = await import("../../src/server/auth/oauth/google");

      const userId = await createTestUser();
      await createTestOAuthLink(userId, "google", { providerAccountId: mockGoogleUserInfo.sub });
      const returnUrl = "/extension/save?url=https%3A%2F%2Fdocs.google.com%2Fd%2F1";
      const { state } = await createGoogleAuthUrl({
        docsAccess: { userId, mode: "extension-save", returnUrl },
      });

      const response = await callback(state, { withStateCookie: false });

      expect(locationOf(response)).toBe(returnUrl);
    });
  });

  describe("Docs-access callback", () => {
    it("keeps the stored refresh token when Google sends none (#1803)", async () => {
      const { createGoogleAuthUrl } = await import("../../src/server/auth/oauth/google");
      const { GOOGLE_DOCS_SCOPE } = await import("../../src/server/google/docs");

      const userId = await createTestUser();
      await createTestOAuthLink(userId, "google", {
        providerAccountId: mockGoogleUserInfo.sub,
        accessToken: "old-access-token",
        refreshToken: "stored-refresh-token",
      });

      const { state } = await createGoogleAuthUrl({ docsAccess: { userId, mode: "save" } });
      const original = { ...mockTokenResponse };
      delete mockTokenResponse.refresh_token;
      mockTokenResponse.scope = `${GOOGLE_GRANTED_SIGN_IN_SCOPE} ${GOOGLE_DOCS_SCOPE}`;
      try {
        const response = await callback(state);
        expect(locationOf(response)).toBe("/save");
      } finally {
        Object.assign(mockTokenResponse, original);
      }

      const [account] = await db
        .select()
        .from(oauthAccounts)
        .where(eq(oauthAccounts.userId, userId));
      expect(account.accessToken).toBe("mock-access-token");
      expect(account.refreshToken).toBe("stored-refresh-token");
      expect(account.scopes).toContain(GOOGLE_DOCS_SCOPE);
    });

    it("never updates the Google account another user linked", async () => {
      const { createGoogleAuthUrl } = await import("../../src/server/auth/oauth/google");

      // The flow's user consents on Google as an account linked to someone else.
      const requesterId = await createTestUser();
      const ownerId = await createTestUser();
      await createTestOAuthLink(ownerId, "google", {
        providerAccountId: mockGoogleUserInfo.sub,
        accessToken: "owner-access-token",
      });

      const { state } = await createGoogleAuthUrl({
        docsAccess: { userId: requesterId, mode: "save" },
      });
      const response = await callback(state);

      expect(locationOf(response)).toBe("/save?error=callback_failed");
      const [account] = await db
        .select()
        .from(oauthAccounts)
        .where(eq(oauthAccounts.userId, ownerId));
      expect(account.accessToken).toBe("owner-access-token");
    });
  });

  describe("PKCE verifier storage", () => {
    it("stores verifier with TTL", async () => {
      const { createGoogleAuthUrl } = await import("../../src/server/auth/oauth/google");

      const result = await createGoogleAuthUrl();

      // Check TTL is set, so an abandoned flow's state expires
      // Use the actual state returned to handle mock variations
      const ttl = await redis.ttl(`oauth:pkce:${result.state}`);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(OAUTH_STATE_TTL_SECONDS);
    });

    it("consumes verifier on use (one-time use)", async () => {
      const { createGoogleAuthUrl } = await import("../../src/server/auth/oauth/google");

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

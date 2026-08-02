/**
 * Integration tests for the Discord OAuth flow.
 *
 * Discord's HTTP endpoints are stubbed at the fetch boundary (we don't control that
 * external service); everything else — state storage in Redis, the authorization URL,
 * the code exchange — is the real code path.
 */

import { describe, it, expect, beforeEach, afterAll, vi, beforeAll } from "vitest";
import { redis } from "../../src/server/redis";

const mockDiscordUserInfo = {
  id: "discord-user-123",
  username: "testuser",
  email: "test@example.com",
  verified: true,
  global_name: "Test User",
};

// Discord's token endpoint response for our mocked authorization code
const mockTokenResponse = {
  access_token: "mock-discord-access-token",
  token_type: "Bearer",
  expires_in: 604800,
  refresh_token: "mock-discord-refresh-token",
  scope: "identify email",
};

// Overwritten per test to exercise the user-info validation branches
let userInfoResponse: Record<string, unknown> = mockDiscordUserInfo;

describe("Discord OAuth", () => {
  let realFetch: typeof globalThis.fetch;

  beforeAll(() => {
    process.env.DISCORD_CLIENT_ID = "test-discord-client-id";
    process.env.DISCORD_CLIENT_SECRET = "test-discord-client-secret";
    process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";

    realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        input instanceof URL ? input.href : input instanceof Request ? input.url : String(input);
      if (url.startsWith("https://discord.com/api/oauth2/token")) {
        return Promise.resolve(
          new Response(JSON.stringify(mockTokenResponse), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        );
      }
      if (url.startsWith("https://discord.com/api/users/@me")) {
        return Promise.resolve(
          new Response(JSON.stringify(userInfoResponse), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        );
      }
      return realFetch(input, init);
    });
  });

  afterAll(async () => {
    delete process.env.DISCORD_CLIENT_ID;
    delete process.env.DISCORD_CLIENT_SECRET;
    vi.unstubAllGlobals();

    const keys = await redis.keys("oauth:discord:*");
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  });

  beforeEach(async () => {
    userInfoResponse = mockDiscordUserInfo;
    const keys = await redis.keys("oauth:discord:*");
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  });

  describe("createDiscordAuthUrl", () => {
    it("generates authorization URL and stores state", async () => {
      const { createDiscordAuthUrl } = await import("../../src/server/auth/oauth/discord");

      const result = await createDiscordAuthUrl();

      const url = new URL(result.url);
      expect(url.origin).toBe("https://discord.com");
      expect(url.searchParams.get("response_type")).toBe("code");
      expect(url.searchParams.get("client_id")).toBe("test-discord-client-id");
      expect(url.searchParams.get("state")).toBe(result.state);
      expect(url.searchParams.get("scope")).toBe("identify email");
      expect(url.searchParams.get("redirect_uri")).toBe(
        "http://localhost:3000/api/v1/auth/oauth/discord/callback"
      );
      // Discord doesn't use PKCE
      expect(url.searchParams.get("code_challenge")).toBeNull();

      const storedState = await redis.get(`oauth:discord:${result.state}`);
      expect(storedState).not.toBeNull();
      expect(JSON.parse(storedState!)).toEqual({});
    });

    it("stores the invite token alongside the state", async () => {
      const { createDiscordAuthUrl } = await import("../../src/server/auth/oauth/discord");

      const result = await createDiscordAuthUrl("invite-abc");

      const storedState = await redis.get(`oauth:discord:${result.state}`);
      expect(JSON.parse(storedState!)).toEqual({ inviteToken: "invite-abc" });
    });
  });

  describe("validateDiscordCallback", () => {
    it("exchanges the code and returns user info and tokens", async () => {
      const { createDiscordAuthUrl, validateDiscordCallback } =
        await import("../../src/server/auth/oauth/discord");

      const { state } = await createDiscordAuthUrl("invite-abc");

      const result = await validateDiscordCallback("mock-auth-code", state);

      expect(result.userInfo.id).toBe("discord-user-123");
      expect(result.userInfo.email).toBe("test@example.com");
      expect(result.tokens.accessToken).toBe("mock-discord-access-token");
      expect(result.tokens.refreshToken).toBe("mock-discord-refresh-token");
      expect(result.tokens.expiresAt?.getTime()).toBeGreaterThan(Date.now());
      expect(result.inviteToken).toBe("invite-abc");
    });

    it("consumes the state (one-time use)", async () => {
      const { createDiscordAuthUrl, validateDiscordCallback } =
        await import("../../src/server/auth/oauth/discord");

      const { state } = await createDiscordAuthUrl();

      await validateDiscordCallback("mock-auth-code", state);

      await expect(validateDiscordCallback("mock-auth-code", state)).rejects.toThrow(
        "Invalid or expired OAuth state"
      );
    });

    it("fails with an unknown state", async () => {
      const { validateDiscordCallback } = await import("../../src/server/auth/oauth/discord");

      await expect(validateDiscordCallback("mock-auth-code", "never-issued")).rejects.toThrow(
        "Invalid or expired OAuth state"
      );
    });

    it("rejects an account whose email Discord has not verified", async () => {
      const { createDiscordAuthUrl, validateDiscordCallback } =
        await import("../../src/server/auth/oauth/discord");

      userInfoResponse = { ...mockDiscordUserInfo, verified: false };
      const { state } = await createDiscordAuthUrl();

      await expect(validateDiscordCallback("mock-auth-code", state)).rejects.toThrow(
        "Discord email is not verified"
      );
    });
  });
});

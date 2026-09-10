/**
 * Integration tests for the browser link flow (issue #1603).
 *
 * These drive the real callback routes, because the bug they cover was in the
 * routing: a link started from Settings used to land in the sign-in branch,
 * which picks the account by the *provider's* email and so created a second
 * account whenever that email differed from the signed-in user's.
 *
 * All three providers are covered, because they differ in exactly the ways that
 * matter here: Google carries the link target in its PKCE blob, Discord in a
 * plain state blob, and Apple arrives as a **cross-site POST** that carries no
 * `SameSite=Lax` session cookie at all.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { NextRequest } from "next/server";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

import { db } from "../../src/server/db";
import { users, sessions, oauthAccounts } from "../../src/server/db/schema";
import { createSession, revokeSession } from "../../src/server/auth/session";
import { OAUTH_STATE_COOKIE_NAME } from "../../src/server/auth/oauth/state-cookie";
import type { OAuthLinkTarget } from "../../src/server/auth/oauth/config";
import { createTestUser } from "./helpers";

const APP_URL = "http://localhost:3000";
const GOOGLE_CLIENT_ID = "test-google-client-id";
const APPLE_CLIENT_ID = "test-apple-client-id";
const APPLE_KID = "test-key";

/** The provider account being linked — deliberately at a different address. */
const PROVIDER_EMAIL = "personal-1603@example.com";
const GOOGLE_SUB = "google-link-sub-1";
const DISCORD_ID = "discord-link-id-1";
const APPLE_SUB = "apple-link-sub-1";

/** What the stubbed provider endpoints report; a test may override it. */
const providerMock = {
  googleSub: GOOGLE_SUB,
  discordId: DISCORD_ID,
  appleSub: APPLE_SUB,
};

const createdUserIds: string[] = [];

async function createUser(): Promise<string> {
  const userId = await createTestUser({ emailPrefix: "link-callback" });
  createdUserIds.push(userId);
  return userId;
}

/** A signed-in user plus the link target their Settings click would produce. */
async function signedInUser(): Promise<{
  userId: string;
  sessionId: string;
  token: string;
  link: OAuthLinkTarget;
}> {
  const userId = await createUser();
  const { sessionId, token } = await createSession(db, { userId });
  return { userId, sessionId, token, link: { userId, sessionId } };
}

function cookieHeader(cookies: { session?: string; oauthState?: string }): string {
  return [
    cookies.session ? `session=${cookies.session}` : null,
    cookies.oauthState ? `${OAUTH_STATE_COOKIE_NAME}=${cookies.oauthState}` : null,
  ]
    .filter(Boolean)
    .join("; ");
}

function callbackRequest(
  url: string,
  cookies: { session?: string; oauthState?: string }
): NextRequest {
  const cookie = cookieHeader(cookies);
  return new NextRequest(url, { headers: cookie ? { cookie } : {} });
}

function locationOf(response: Response): string {
  const location = new URL(response.headers.get("location") ?? "");
  return location.pathname + location.search;
}

function linkedAccounts(userId: string, provider: string) {
  return db
    .select()
    .from(oauthAccounts)
    .where(and(eq(oauthAccounts.userId, userId), eq(oauthAccounts.provider, provider)));
}

function strayAccounts() {
  return db.select().from(users).where(eq(users.email, PROVIDER_EMAIL));
}

describe("OAuth link callback", () => {
  let realFetch: typeof globalThis.fetch;
  let appleSigningKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];

  beforeAll(async () => {
    process.env.GOOGLE_CLIENT_ID = GOOGLE_CLIENT_ID;
    process.env.GOOGLE_CLIENT_SECRET = "test-google-client-secret";
    process.env.DISCORD_CLIENT_ID = "test-discord-client-id";
    process.env.DISCORD_CLIENT_SECRET = "test-discord-client-secret";
    process.env.APPLE_CLIENT_ID = APPLE_CLIENT_ID;
    process.env.APPLE_TEAM_ID = "test-team-id";
    process.env.APPLE_KEY_ID = "test-key-id";
    // Test-only EC P-256 key, used solely to sign the client-secret JWT.
    process.env.APPLE_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgevZzL1gdAFr88hb2
OF/2NxApJCzGCEDdfSp6VQO30hyhRANCAAQRWz+jn65BtOMvdyHKcvjBeBSDZH2r
1RTwjmYSi9R/zpBnuQ4EiMnCqfMPWiZqB4QdbAd0E7oH50VpuZ1P087G
-----END PRIVATE KEY-----`;
    process.env.NEXT_PUBLIC_APP_URL = APP_URL;

    // Apple's id_token is signature-verified against its published JWKS, so sign
    // with a real key and serve its public half from the stubbed endpoint.
    const appleKeys = await generateKeyPair("RS256", { extractable: true });
    appleSigningKey = appleKeys.privateKey;
    const applePublicJwk = await exportJWK(appleKeys.publicKey);
    Object.assign(applePublicJwk, { kid: APPLE_KID, alg: "RS256", use: "sig" });

    async function signAppleIdToken(): Promise<string> {
      return new SignJWT({ email: PROVIDER_EMAIL, email_verified: "true" })
        .setProtectedHeader({ alg: "RS256", kid: APPLE_KID })
        .setIssuer("https://appleid.apple.com")
        .setAudience(APPLE_CLIENT_ID)
        .setSubject(providerMock.appleSub)
        .setIssuedAt()
        .setExpirationTime("1h")
        .sign(appleSigningKey);
    }

    // Stub the providers at the HTTP boundary so the real code exchange, PKCE,
    // state handling and id_token verification stay under test.
    realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        input instanceof URL ? input.href : input instanceof Request ? input.url : String(input);

      if (url.startsWith("https://oauth2.googleapis.com/token")) {
        return Response.json({
          access_token: "google-access-token",
          token_type: "Bearer",
          expires_in: 3600,
          refresh_token: "google-refresh-token",
          scope: "openid email profile",
        });
      }
      if (url.startsWith("https://www.googleapis.com/oauth2/v3/userinfo")) {
        return Response.json({
          sub: providerMock.googleSub,
          email: PROVIDER_EMAIL,
          email_verified: true,
        });
      }
      if (url.startsWith("https://discord.com/api/oauth2/token")) {
        return Response.json({
          access_token: "discord-access-token",
          token_type: "Bearer",
          expires_in: 3600,
          refresh_token: "discord-refresh-token",
        });
      }
      if (url.startsWith("https://discord.com/api/users/@me")) {
        return Response.json({
          id: providerMock.discordId,
          username: "linker",
          email: PROVIDER_EMAIL,
          verified: true,
        });
      }
      if (url.includes("appleid.apple.com/auth/keys")) {
        return Response.json({ keys: [applePublicJwk] });
      }
      if (url.startsWith("https://appleid.apple.com/auth/token")) {
        return Response.json({
          access_token: "apple-access-token",
          token_type: "Bearer",
          expires_in: 3600,
          refresh_token: "apple-refresh-token",
          id_token: await signAppleIdToken(),
        });
      }

      return realFetch(input, init);
    });
  });

  beforeEach(() => {
    providerMock.googleSub = GOOGLE_SUB;
    providerMock.discordId = DISCORD_ID;
    providerMock.appleSub = APPLE_SUB;
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    for (const key of [
      "GOOGLE_CLIENT_ID",
      "GOOGLE_CLIENT_SECRET",
      "DISCORD_CLIENT_ID",
      "DISCORD_CLIENT_SECRET",
      "APPLE_CLIENT_ID",
      "APPLE_TEAM_ID",
      "APPLE_KEY_ID",
      "APPLE_PRIVATE_KEY",
    ]) {
      delete process.env[key];
    }
    if (createdUserIds.length > 0) {
      await db.delete(users).where(inArray(users.id, createdUserIds));
    }
    await db.delete(users).where(eq(users.email, PROVIDER_EMAIL));
  });

  /** Starts a link flow the way `auth.linkAuthUrl` does, returning its state. */
  async function startGoogleLink(link: OAuthLinkTarget): Promise<string> {
    const { createGoogleAuthUrl } = await import("../../src/server/auth/oauth/google");
    return (await createGoogleAuthUrl({ link })).state;
  }

  async function startDiscordLink(link: OAuthLinkTarget): Promise<string> {
    const { createDiscordAuthUrl } = await import("../../src/server/auth/oauth/discord");
    return (await createDiscordAuthUrl({ link })).state;
  }

  async function startAppleLink(link: OAuthLinkTarget): Promise<string> {
    const { createAppleAuthUrl } = await import("../../src/server/auth/oauth/apple");
    return (await createAppleAuthUrl({ link })).state;
  }

  async function googleCallback(
    state: string,
    cookies: { session?: string; oauthState?: string }
  ): Promise<Response> {
    const { GET } = await import("../../src/app/api/v1/auth/oauth/google/callback/route");
    return GET(
      callbackRequest(
        `${APP_URL}/api/v1/auth/oauth/google/callback?code=auth-code&state=${state}`,
        cookies
      )
    );
  }

  it("links the provider account to the flow's user when the emails differ", async () => {
    const { userId, link, token } = await signedInUser();
    const state = await startGoogleLink(link);

    const response = await googleCallback(state, { session: token, oauthState: state });

    expect(locationOf(response)).toBe("/settings?linked=google");

    const links = await linkedAccounts(userId, "google");
    expect(links).toHaveLength(1);
    expect(links[0].providerAccountId).toBe(GOOGLE_SUB);
    expect(links[0].accessToken).toBe("google-access-token");

    // The bug: the provider's email used to create (or sign the visitor into) a
    // second account.
    expect(await strayAccounts()).toHaveLength(0);
  });

  it("links to the user who started the flow, not whoever the browser is signed in as", async () => {
    const { userId, link } = await signedInUser();
    const bystander = await signedInUser();
    providerMock.googleSub = "google-link-sub-bystander";
    const state = await startGoogleLink(link);

    // Same browser, but the session cookie now belongs to a different account.
    const response = await googleCallback(state, {
      session: bystander.token,
      oauthState: state,
    });

    expect(locationOf(response)).toBe("/settings?linked=google");
    expect(await linkedAccounts(userId, "google")).toHaveLength(1);
    expect(await linkedAccounts(bystander.userId, "google")).toHaveLength(0);
  });

  it("revokes the user's other sessions but keeps the one that linked", async () => {
    const { userId, sessionId, link, token } = await signedInUser();
    const other = await createSession(db, { userId });
    providerMock.googleSub = "google-link-sub-revoke";
    const state = await startGoogleLink(link);

    await googleCallback(state, { session: token, oauthState: state });

    const rows = await db.select().from(sessions).where(eq(sessions.userId, userId));
    expect(rows.find((row) => row.id === sessionId)?.revokedAt).toBeNull();
    expect(rows.find((row) => row.id === other.sessionId)?.revokedAt).not.toBeNull();
  });

  it("refuses to link — and never signs anyone in — once the flow's session is gone", async () => {
    const { userId, sessionId, link, token } = await signedInUser();
    providerMock.googleSub = "google-link-sub-logged-out";
    const state = await startGoogleLink(link);
    await revokeSession(sessionId);

    const response = await googleCallback(state, { session: token, oauthState: state });

    expect(locationOf(response)).toBe("/login?error=link_requires_login");
    expect(response.headers.get("set-cookie") ?? "").not.toContain("session=");
    expect(await linkedAccounts(userId, "google")).toHaveLength(0);
    expect(await strayAccounts()).toHaveLength(0);
  });

  it("reports a provider account that already belongs to another user", async () => {
    const owner = await signedInUser();
    const linker = await signedInUser();
    providerMock.googleSub = "google-link-sub-taken";

    const { linkOAuthAccount } = await import("../../src/server/services/oauth-accounts");
    await linkOAuthAccount(db, {
      userId: owner.userId,
      currentSessionId: owner.sessionId,
      provider: "google",
      providerAccountId: providerMock.googleSub,
      accessToken: "owner-token",
    });

    const state = await startGoogleLink(linker.link);
    const response = await googleCallback(state, { session: linker.token, oauthState: state });

    expect(locationOf(response)).toBe("/settings?link_error=already_linked");
    expect(await linkedAccounts(linker.userId, "google")).toHaveLength(0);
  });

  it("links Discord to the flow's user", async () => {
    const { userId, link, token } = await signedInUser();
    const state = await startDiscordLink(link);

    const { GET } = await import("../../src/app/api/v1/auth/oauth/discord/callback/route");
    const response = await GET(
      callbackRequest(
        `${APP_URL}/api/v1/auth/oauth/discord/callback?code=auth-code&state=${state}`,
        { session: token, oauthState: state }
      )
    );

    expect(locationOf(response)).toBe("/settings?linked=discord");

    const links = await linkedAccounts(userId, "discord");
    expect(links).toHaveLength(1);
    expect(links[0].providerAccountId).toBe(DISCORD_ID);
  });

  it("links Apple, whose cross-site POST carries no session cookie", async () => {
    const { userId, link } = await signedInUser();
    const state = await startAppleLink(link);

    const form = new FormData();
    form.set("code", "auth-code");
    form.set("state", state);

    const { POST } = await import("../../src/app/api/v1/auth/oauth/apple/callback/route");
    const response = await POST(
      new NextRequest(`${APP_URL}/api/v1/auth/oauth/apple/callback`, {
        method: "POST",
        body: form,
        // Only the state cookie survives a cross-site POST (SameSite=None); the
        // session cookie is SameSite=Lax and is deliberately absent.
        headers: { cookie: cookieHeader({ oauthState: state }) },
      })
    );

    expect(response.status).toBe(303);
    expect(locationOf(response)).toBe("/settings?linked=apple");

    const links = await linkedAccounts(userId, "apple");
    expect(links).toHaveLength(1);
    expect(links[0].providerAccountId).toBe(APPLE_SUB);
    expect(await strayAccounts()).toHaveLength(0);
  });

  it("rejects a link state presented to the tRPC sign-in callback", async () => {
    const { link } = await signedInUser();
    providerMock.googleSub = "google-link-sub-trpc";
    const state = await startGoogleLink(link);

    const { createCaller } = await import("../../src/server/trpc/root");
    const caller = createCaller({
      db,
      session: null,
      apiToken: null,
      authType: null,
      scopes: [],
      sessionToken: null,
      headers: new Headers(),
      resHeaders: undefined,
    });

    await expect(caller.auth.googleCallback({ code: "auth-code", state })).rejects.toThrow(
      /link an account/
    );
    expect(await strayAccounts()).toHaveLength(0);
  });
});

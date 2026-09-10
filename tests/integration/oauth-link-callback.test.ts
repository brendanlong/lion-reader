/**
 * Integration tests for the browser link flow (`mode: "link"`, issue #1603).
 *
 * These drive the real callback routes, because the bug they cover was in the
 * routing: a link started from Settings used to land in the login branch, which
 * picks the account by the *provider's* email and so created a second account
 * whenever that email differed from the signed-in user's.
 *
 * Google and Discord cover the two shapes of the flow (PKCE + userinfo endpoint,
 * and plain state + `/users/@me`); Apple shares `createLinkResponse` with them
 * and differs only in how its identity is verified, which `apple-oauth.test.ts`
 * covers.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { NextRequest } from "next/server";
import { generateKeyPair, SignJWT } from "jose";

import { db } from "../../src/server/db";
import { users, sessions, oauthAccounts } from "../../src/server/db/schema";
import { createSession } from "../../src/server/auth/session";
import { OAUTH_STATE_COOKIE_NAME } from "../../src/server/auth/oauth/state-cookie";
import { createTestUser } from "./helpers";

const APP_URL = "http://localhost:3000";
const GOOGLE_CLIENT_ID = "test-client-id";

/** The Google account being linked — deliberately a different address than the user's. */
const GOOGLE_SUB = "google-link-sub-1";
const PROVIDER_EMAIL = "personal-1603@example.com";

const DISCORD_ID = "discord-link-id-1";

const createdUserIds: string[] = [];

async function createUser(): Promise<string> {
  const userId = await createTestUser({ emailPrefix: "link-callback" });
  createdUserIds.push(userId);
  return userId;
}

async function signGoogleIdToken(): Promise<string> {
  const { privateKey } = await generateKeyPair("RS256", { extractable: true });
  return new SignJWT({ email: PROVIDER_EMAIL, email_verified: true })
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer("https://accounts.google.com")
    .setAudience(GOOGLE_CLIENT_ID)
    .setSubject(GOOGLE_SUB)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(privateKey);
}

/** The provider identity the stubbed endpoints return; a test may override it. */
const providerMock = {
  googleSub: GOOGLE_SUB,
  discordId: DISCORD_ID,
  idToken: "",
};

function callbackRequest(
  url: string,
  cookies: { session?: string; oauthState?: string }
): NextRequest {
  const cookie = [
    cookies.session ? `session=${cookies.session}` : null,
    cookies.oauthState ? `${OAUTH_STATE_COOKIE_NAME}=${cookies.oauthState}` : null,
  ]
    .filter(Boolean)
    .join("; ");

  return new NextRequest(url, { headers: cookie ? { cookie } : {} });
}

function locationOf(response: Response): string {
  return (
    new URL(response.headers.get("location") ?? "").pathname +
    new URL(response.headers.get("location") ?? "").search
  );
}

async function linkedAccounts(userId: string, provider: string) {
  return db
    .select()
    .from(oauthAccounts)
    .where(and(eq(oauthAccounts.userId, userId), eq(oauthAccounts.provider, provider)));
}

describe("OAuth link callback (mode: link)", () => {
  let realFetch: typeof globalThis.fetch;

  beforeAll(async () => {
    process.env.GOOGLE_CLIENT_ID = GOOGLE_CLIENT_ID;
    process.env.GOOGLE_CLIENT_SECRET = "test-client-secret";
    process.env.DISCORD_CLIENT_ID = "test-discord-client-id";
    process.env.DISCORD_CLIENT_SECRET = "test-discord-client-secret";
    process.env.NEXT_PUBLIC_APP_URL = APP_URL;

    providerMock.idToken = await signGoogleIdToken();

    // Stub the providers at the HTTP boundary so the real code exchange, PKCE and
    // state handling stay under test.
    realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        input instanceof URL ? input.href : input instanceof Request ? input.url : String(input);

      if (url.startsWith("https://oauth2.googleapis.com/token")) {
        return Promise.resolve(
          Response.json({
            access_token: "google-access-token",
            token_type: "Bearer",
            expires_in: 3600,
            refresh_token: "google-refresh-token",
            scope: "openid email profile",
            id_token: providerMock.idToken,
          })
        );
      }
      if (url.startsWith("https://www.googleapis.com/oauth2/v3/userinfo")) {
        return Promise.resolve(
          Response.json({
            sub: providerMock.googleSub,
            email: PROVIDER_EMAIL,
            email_verified: true,
          })
        );
      }
      if (url.startsWith("https://discord.com/api/oauth2/token")) {
        return Promise.resolve(
          Response.json({
            access_token: "discord-access-token",
            token_type: "Bearer",
            expires_in: 3600,
            refresh_token: "discord-refresh-token",
          })
        );
      }
      if (url.startsWith("https://discord.com/api/users/@me")) {
        return Promise.resolve(
          Response.json({
            id: providerMock.discordId,
            username: "linker",
            email: PROVIDER_EMAIL,
            verified: true,
          })
        );
      }

      return realFetch(input, init);
    });
  });

  beforeEach(() => {
    providerMock.googleSub = GOOGLE_SUB;
    providerMock.discordId = DISCORD_ID;
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
    delete process.env.DISCORD_CLIENT_ID;
    delete process.env.DISCORD_CLIENT_SECRET;
    if (createdUserIds.length > 0) {
      await db.delete(users).where(inArray(users.id, createdUserIds));
    }
    await db.delete(users).where(eq(users.email, PROVIDER_EMAIL));
  });

  /** Starts a link flow and returns the state the provider will echo back. */
  async function startGoogleLink(): Promise<string> {
    const { createGoogleAuthUrl } = await import("../../src/server/auth/oauth/google");
    const { state } = await createGoogleAuthUrl({ mode: "link" });
    return state;
  }

  async function startDiscordLink(): Promise<string> {
    const { createDiscordAuthUrl } = await import("../../src/server/auth/oauth/discord");
    const { state } = await createDiscordAuthUrl({ mode: "link" });
    return state;
  }

  it("links the provider account to the session's user when the emails differ", async () => {
    const userId = await createUser();
    const { token } = await createSession(db, { userId });
    const state = await startGoogleLink();

    const { GET } = await import("../../src/app/api/v1/auth/oauth/google/callback/route");
    const response = await GET(
      callbackRequest(
        `${APP_URL}/api/v1/auth/oauth/google/callback?code=auth-code&state=${state}`,
        {
          session: token,
          oauthState: state,
        }
      )
    );

    expect(locationOf(response)).toBe("/settings?linked=google");

    const links = await linkedAccounts(userId, "google");
    expect(links).toHaveLength(1);
    expect(links[0].providerAccountId).toBe(GOOGLE_SUB);
    expect(links[0].accessToken).toBe("google-access-token");

    // The bug: the provider's email used to create (or sign the visitor into) a
    // second account.
    const strays = await db.select().from(users).where(eq(users.email, PROVIDER_EMAIL));
    expect(strays).toHaveLength(0);
  });

  it("revokes the user's other sessions but keeps the one that linked", async () => {
    const userId = await createUser();
    const { token, sessionId } = await createSession(db, { userId });
    const other = await createSession(db, { userId });
    const state = await startGoogleLink();

    providerMock.googleSub = "google-link-sub-revoke";
    const { GET } = await import("../../src/app/api/v1/auth/oauth/google/callback/route");
    await GET(
      callbackRequest(
        `${APP_URL}/api/v1/auth/oauth/google/callback?code=auth-code&state=${state}`,
        {
          session: token,
          oauthState: state,
        }
      )
    );

    const rows = await db.select().from(sessions).where(eq(sessions.userId, userId));
    const current = rows.find((row) => row.id === sessionId);
    const revoked = rows.find((row) => row.id === other.sessionId);
    expect(current?.revokedAt).toBeNull();
    expect(revoked?.revokedAt).not.toBeNull();
  });

  it("refuses to link — and never signs anyone in — without a session", async () => {
    const state = await startGoogleLink();
    providerMock.googleSub = "google-link-sub-anon";

    const { GET } = await import("../../src/app/api/v1/auth/oauth/google/callback/route");
    const response = await GET(
      callbackRequest(
        `${APP_URL}/api/v1/auth/oauth/google/callback?code=auth-code&state=${state}`,
        {
          oauthState: state,
        }
      )
    );

    expect(locationOf(response)).toBe("/login?error=link_requires_login");
    expect(response.cookies.get("session")).toBeUndefined();

    const strays = await db.select().from(users).where(eq(users.email, PROVIDER_EMAIL));
    expect(strays).toHaveLength(0);
  });

  it("reports a provider account that already belongs to another user", async () => {
    const owner = await createUser();
    const linker = await createUser();
    providerMock.googleSub = "google-link-sub-taken";

    const { linkOAuthAccount } = await import("../../src/server/services/oauth-accounts");
    await linkOAuthAccount(db, {
      userId: owner,
      currentSessionId: (await createSession(db, { userId: owner })).sessionId,
      provider: "google",
      providerAccountId: providerMock.googleSub,
      accessToken: "owner-token",
    });

    const { token } = await createSession(db, { userId: linker });
    const state = await startGoogleLink();

    const { GET } = await import("../../src/app/api/v1/auth/oauth/google/callback/route");
    const response = await GET(
      callbackRequest(
        `${APP_URL}/api/v1/auth/oauth/google/callback?code=auth-code&state=${state}`,
        {
          session: token,
          oauthState: state,
        }
      )
    );

    expect(locationOf(response)).toBe("/settings?link_error=already_linked");
    expect(await linkedAccounts(linker, "google")).toHaveLength(0);
  });

  it("links Discord to the session's user too", async () => {
    const userId = await createUser();
    const { token } = await createSession(db, { userId });
    const state = await startDiscordLink();

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
});

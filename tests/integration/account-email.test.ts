/**
 * Integration tests for account emails: verifying an address and resetting a
 * password. Mailgun is stubbed at the fetch boundary; the emails it receives
 * are where the tests read their links from.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";

import { db } from "../../src/server/db";
import {
  apiTokens,
  emailTokens,
  oauthAccounts,
  oauthTokenGrants,
  sessions,
  users,
} from "../../src/server/db/schema";
import { createCaller } from "../../src/server/trpc/root";
import { generateUuidv7 } from "../../src/lib/uuidv7";
import { createSession } from "../../src/server/auth/session";
import { createApiToken } from "../../src/server/auth/api-token";
import { hashPassword, verifyEmailPassword } from "../../src/server/auth/password";
import { RATE_LIMIT_CONFIGS } from "../../src/server/rate-limit/token-bucket";
import { WALLABAG_CLIENT_ID } from "../../src/server/wallabag/client";
import {
  createAuthContext,
  createTestOAuthLink,
  createTestTokenGrant,
  createTestUser,
  createUnauthContext,
  deleteUsers,
} from "./helpers";

interface SentEmail {
  authorization: string | null;
  from: string | null;
  to: string | null;
  subject: string | null;
  text: string;
}

let sent: SentEmail[] = [];

function sentTo(email: string): SentEmail[] {
  return sent.filter((message) => message.to === email);
}

function linkToken(message: SentEmail, path: string): string {
  const match = message.text.match(new RegExp(`${path}\\?token=([\\w-]+)`));
  if (!match) throw new Error(`No ${path} link in: ${message.text}`);
  return match[1];
}

async function waitForEmailTo(email: string): Promise<SentEmail> {
  return vi.waitFor(() => {
    const [message] = sentTo(email);
    if (!message) throw new Error(`No email to ${email} yet`);
    return message;
  });
}

/** Rate-limit buckets are per address and outlive a test run. */
function uniqueEmail(name: string): string {
  return `${name}-${generateUuidv7()}@example.com`;
}

const PASSWORD = "correct horse battery";
const NEW_PASSWORD = "new staple battery";

const ENV_KEYS = ["MAILGUN_DOMAIN", "MAILGUN_SENDING_KEY", "ALLOWED_PUBLIC_SIGNUP_PROVIDERS"];
const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

beforeAll(() => {
  process.env.MAILGUN_DOMAIN = "mail.example.com";
  process.env.MAILGUN_SENDING_KEY = "test-sending-key";
  process.env.ALLOWED_PUBLIC_SIGNUP_PROVIDERS = "email";

  const realFetch = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof URL ? input.href : input instanceof Request ? input.url : input;
    if (url === "https://api.mailgun.net/v3/mail.example.com/messages") {
      const body = new URLSearchParams(String(init?.body));
      sent.push({
        authorization: new Headers(init?.headers).get("authorization"),
        from: body.get("from"),
        to: body.get("to"),
        subject: body.get("subject"),
        text: body.get("text") ?? "",
      });
      return new Response(JSON.stringify({ id: "<id@mail.example.com>" }), { status: 200 });
    }
    return realFetch(input, init);
  });
});

afterAll(async () => {
  vi.unstubAllGlobals();
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
  await deleteUsers();
});

beforeEach(async () => {
  sent = [];
  await deleteUsers();
});

describe("email verification", () => {
  it("emails a link on signup that verifies the new account through Mailgun", async () => {
    const email = uniqueEmail("new-reader");
    const { user } = await createCaller(createUnauthContext()).auth.register({
      email,
      password: PASSWORD,
    });

    const message = await waitForEmailTo(email);
    expect(message.from).toBe("Lion Reader <noreply@mail.example.com>");
    expect(message.authorization).toBe(
      `Basic ${Buffer.from("api:test-sending-key").toString("base64")}`
    );

    await createCaller(await createAuthContext(user.id)).auth.verifyEmail({
      token: linkToken(message, "/verify-email"),
    });

    const [row] = await db.select().from(users).where(eq(users.id, user.id));
    expect(row.emailVerifiedAt).not.toBeNull();
  });

  it("refuses another signed-in account's link and leaves it usable by its owner", async () => {
    const ownerId = await createTestUser({ emailVerifiedAt: null });
    const otherId = await createTestUser({ emailVerifiedAt: null });
    const owner = createCaller(await createAuthContext(ownerId));
    await owner.auth.resendVerificationEmail({});
    const [ownerRow] = await db.select().from(users).where(eq(users.id, ownerId));
    const token = linkToken(sentTo(ownerRow.email)[0], "/verify-email");

    await expect(
      createCaller(await createAuthContext(otherId)).auth.verifyEmail({ token })
    ).rejects.toThrow(/different account/);
    const [otherRow] = await db.select().from(users).where(eq(users.id, otherId));
    expect(otherRow.emailVerifiedAt).toBeNull();

    await owner.auth.verifyEmail({ token });
    const [verified] = await db.select().from(users).where(eq(users.id, ownerId));
    expect(verified.emailVerifiedAt).not.toBeNull();
  });

  it("refuses an expired link", async () => {
    const userId = await createTestUser({ emailVerifiedAt: null });
    const caller = createCaller(await createAuthContext(userId));
    await caller.auth.resendVerificationEmail({});
    await db
      .update(emailTokens)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(emailTokens.userId, userId));

    await expect(
      caller.auth.verifyEmail({ token: linkToken(sent[0], "/verify-email") })
    ).rejects.toThrow(/invalid or has expired/);
  });

  it("limits how many emails one address gets", async () => {
    const userId = await createTestUser({ emailVerifiedAt: null });
    const caller = createCaller(await createAuthContext(userId));

    for (let i = 0; i < RATE_LIMIT_CONFIGS.accountEmail.capacity; i++) {
      await caller.auth.resendVerificationEmail({});
    }
    await expect(caller.auth.resendVerificationEmail({})).rejects.toMatchObject({
      code: "TOO_MANY_REQUESTS",
    });
    expect(sent).toHaveLength(RATE_LIMIT_CONFIGS.accountEmail.capacity);
  });
});

describe("password reset", () => {
  const anonymous = () => createCaller(createUnauthContext());

  async function resetToken(email: string): Promise<string> {
    await anonymous().auth.requestPasswordReset({ email });
    return linkToken(await waitForEmailTo(email), "/reset-password");
  }

  it("sends nothing for an address without an account, and says so to nobody", async () => {
    await expect(
      anonymous().auth.requestPasswordReset({ email: uniqueEmail("nobody") })
    ).resolves.toEqual({ success: true });
    // The email is sent after the request returns; give it the chance to go wrong.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sent).toEqual([]);
  });

  it("sets the password once, revoking sessions and password-derived grants only", async () => {
    const email = uniqueEmail("reader");
    const userId = await createTestUser({ email, passwordHash: await hashPassword(PASSWORD) });
    const { sessionId } = await createSession(db, { userId });
    const { id: apiTokenId } = await createApiToken(userId, ["mcp"]);
    await createTestTokenGrant(userId, { clientId: WALLABAG_CLIENT_ID });
    await createTestOAuthLink(userId, "google");
    const token = await resetToken(email);

    const { sessionToken } = await anonymous().auth.resetPassword({
      token,
      newPassword: NEW_PASSWORD,
    });

    expect(sessionToken).toBeTruthy();
    expect((await verifyEmailPassword(db, email, NEW_PASSWORD)).valid).toBe(true);
    const [oldSession] = await db.select().from(sessions).where(eq(sessions.id, sessionId));
    expect(oldSession.revokedAt).not.toBeNull();
    expect(
      await db.select().from(oauthTokenGrants).where(eq(oauthTokenGrants.userId, userId))
    ).toEqual([]);
    const [apiToken] = await db.select().from(apiTokens).where(eq(apiTokens.id, apiTokenId));
    expect(apiToken.revokedAt).toBeNull();
    expect(
      await db.select().from(oauthAccounts).where(eq(oauthAccounts.userId, userId))
    ).toHaveLength(1);

    await expect(
      anonymous().auth.resetPassword({ token, newPassword: "a third password" })
    ).rejects.toThrow(/invalid or has expired/);
  });

  it("refuses a verification link as a reset link", async () => {
    const userId = await createTestUser({ emailVerifiedAt: null });
    await createCaller(await createAuthContext(userId)).auth.resendVerificationEmail({});

    await expect(
      anonymous().auth.resetPassword({
        token: linkToken(sent[0], "/verify-email"),
        newPassword: NEW_PASSWORD,
      })
    ).rejects.toThrow(/invalid or has expired/);
  });

  it("refuses an older link once the password changes another way", async () => {
    const email = uniqueEmail("changer");
    const userId = await createTestUser({ email, passwordHash: await hashPassword(PASSWORD) });
    const token = await resetToken(email);

    await createCaller(await createAuthContext(userId)).users["me.changePassword"]({
      currentPassword: PASSWORD,
      newPassword: NEW_PASSWORD,
    });

    await expect(
      anonymous().auth.resetPassword({ token, newPassword: "a third password" })
    ).rejects.toThrow(/invalid or has expired/);
  });

  it("claims an unverified account from whoever registered the address", async () => {
    const email = uniqueEmail("victim");
    const userId = await createTestUser({ email, emailVerifiedAt: null });
    const { sessionId } = await createSession(db, { userId });
    const { id: apiTokenId } = await createApiToken(userId, ["mcp"]);
    await createTestOAuthLink(userId, "discord");
    const token = await resetToken(email);

    await anonymous().auth.resetPassword({ token, newPassword: NEW_PASSWORD });

    const [row] = await db.select().from(users).where(eq(users.id, userId));
    expect(row.emailVerifiedAt).not.toBeNull();
    expect(row.tosAgreedAt).toBeNull();
    const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId));
    expect(session.revokedAt).not.toBeNull();
    const [apiToken] = await db.select().from(apiTokens).where(eq(apiTokens.id, apiTokenId));
    expect(apiToken.revokedAt).not.toBeNull();
    expect(await db.select().from(oauthAccounts).where(eq(oauthAccounts.userId, userId))).toEqual(
      []
    );
  });
});

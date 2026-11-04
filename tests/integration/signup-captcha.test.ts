/**
 * Password signup's Turnstile check, with Cloudflare's siteverify stubbed at the
 * fetch boundary.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";

import { db } from "../../src/server/db";
import { users } from "../../src/server/db/schema";
import { createCaller } from "../../src/server/trpc/root";
import { generateUuidv7 } from "../../src/lib/uuidv7";
import { TURNSTILE_ORIGIN } from "../../src/lib/turnstile";
import { createUnauthContext, deleteUsers } from "./helpers";

const PASSING_TOKEN = "passing-token";
let verified: URLSearchParams[] = [];

const ENV_KEYS = ["TURNSTILE_SITE_KEY", "TURNSTILE_SECRET_KEY", "ALLOWED_PUBLIC_SIGNUP_PROVIDERS"];
const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

beforeAll(() => {
  process.env.TURNSTILE_SITE_KEY = "test-site-key";
  process.env.TURNSTILE_SECRET_KEY = "test-secret-key";
  process.env.ALLOWED_PUBLIC_SIGNUP_PROVIDERS = "email";

  const realFetch = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof URL ? input.href : input instanceof Request ? input.url : input;
    if (url === `${TURNSTILE_ORIGIN}/turnstile/v0/siteverify`) {
      const body = new URLSearchParams(String(init?.body));
      verified.push(body);
      const success = body.get("response") === PASSING_TOKEN;
      return new Response(JSON.stringify({ success, "error-codes": [] }), { status: 200 });
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

beforeEach(() => {
  verified = [];
});

function register(
  captchaToken: string | undefined,
  email = `captcha-${generateUuidv7()}@example.com`
) {
  const attempt = createCaller(createUnauthContext()).auth.register({
    email,
    password: "correct horse battery",
    captchaToken,
  });
  return { email, attempt };
}

async function accountExists(email: string): Promise<boolean> {
  return (await db.select().from(users).where(eq(users.email, email))).length > 0;
}

describe("password signup CAPTCHA", () => {
  it("tells the register page the site key", async () => {
    const config = await createCaller(createUnauthContext()).auth.signupConfig();
    expect(config.turnstileSiteKey).toBe("test-site-key");
  });

  it("creates the account once Cloudflare passes the token", async () => {
    const { email, attempt } = register(PASSING_TOKEN);
    await attempt;

    expect(await accountExists(email)).toBe(true);
    expect(verified[0].get("secret")).toBe("test-secret-key");
  });

  it("checks the CAPTCHA before saying an address has an account", async () => {
    const existing = register(PASSING_TOKEN);
    await existing.attempt;

    await expect(register("failing-token", existing.email).attempt).rejects.toThrow(/CAPTCHA/);
  });

  it.each([
    ["a token Cloudflare fails", "failing-token"],
    ["no token", undefined],
  ])("refuses %s without creating the account", async (_, token) => {
    const { email, attempt } = register(token);

    await expect(attempt).rejects.toThrow(/CAPTCHA/);
    expect(await accountExists(email)).toBe(false);
  });
});

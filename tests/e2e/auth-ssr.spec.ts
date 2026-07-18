/**
 * E2E tests for the statically-served auth pages (/login, /register).
 *
 * Since issue #1359 these pages are prerendered — at build time, then
 * re-rendered once per process startup with runtime env (the revalidate-public
 * hook in scripts/server.ts) — instead of per-request SSR. The signup/provider
 * config is prefetched request-free by the `(public)/(auth)` layout, so the
 * config-driven content (#1328: invite-required state, signup link, OAuth
 * buttons) is in the served HTML, and the already-signed-in redirect moved to
 * a session-validating check in src/proxy.ts. These tests pin: the static
 * HTML contains the form and the SSR'd config (and no per-request nonce), the
 * `?invite=`/`?error=` params still work client-side, and the proxy redirects
 * behave for anonymous, valid-session, and dead-session visitors.
 *
 * The e2e env sets no `ALLOWED_PUBLIC_SIGNUP_PROVIDERS`, so the instance is
 * invite-only (public providers empty); `ALLOWED_SIGNUP_PROVIDERS` defaults to
 * all, so presenting any `?invite=` token renders the full signup form.
 */

import { test, expect } from "@playwright/test";
import {
  getDb,
  createConfirmedUser,
  createPasswordUser,
  loginAs,
  closeTestConnections,
} from "./helpers";

test.afterAll(async () => {
  await closeTestConnections();
});

test("/login serves the sign-in form in the static HTML", async ({ request }) => {
  const response = await request.get("/login");
  expect(response.status()).toBe(200);
  const html = await response.text();

  // The form itself is prerendered — visible before any JS runs.
  expect(html).toContain("Sign in to your account");
  expect(html).toContain("Or continue with email");
  // The SSR'd signup config gates the signup link off (invite-only instance),
  // and there's no client-side loading placeholder.
  expect(html).not.toContain("Create one");
  expect(html).not.toContain("Loading...");
  // Static pages carry no per-request nonce (they get the relaxed static CSP).
  expect(html).not.toContain('nonce="');
});

test("/register serves the invite-required state in the static HTML", async ({ request }) => {
  const response = await request.get("/register");
  expect(response.status()).toBe(200);
  const html = await response.text();

  // The config-driven invite-required state is prerendered (#1328 behavior,
  // preserved via the startup-time re-render), not client-fetched.
  expect(html).toContain("Invite Required");
  expect(html).not.toContain("Loading...");
});

test("/login surfaces an OAuth callback error from the query string", async ({ page }) => {
  await page.goto("/login?error=invalid_state");
  await expect(page.getByText("Authentication failed. Please try again.")).toBeVisible();
});

test("logging in through the form works and honors ?redirect", async ({ page }) => {
  const db = getDb();
  const user = await createPasswordUser(db);

  await page.goto("/login?redirect=%2Fstarred");
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password").fill(user.password);
  await page.getByRole("button", { name: "Sign in" }).click();

  // The redirect param is honored (sanitized to a same-origin path).
  await page.waitForURL("**/starred");
  await expect(page.getByRole("main")).toBeVisible();
});

test("/register with an invite token renders the full signup form", async ({ page }) => {
  await page.goto("/register?invite=any-token");
  // The static HTML is the no-invite variant; hydration threads the token in
  // and the full allowlist applies (email is a default provider), so the
  // account form replaces the invite-required state.
  await expect(page.getByRole("heading", { name: "Create your account" })).toBeVisible();
  await expect(page.getByText("Invite Required")).toHaveCount(0);
});

test("anonymous visitors to / are redirected straight to the demo by the proxy", async ({
  request,
}) => {
  const response = await request.get("/", { maxRedirects: 0 });
  expect(response.status()).toBe(307);
  expect(response.headers()["location"]).toContain("/demo/all?entry=welcome");
});

test("a signed-in user is redirected from /, /login, and /register into the app", async ({
  page,
  baseURL,
}) => {
  const db = getDb();
  const user = await createConfirmedUser(db);
  await loginAs(page.context(), user, baseURL!);

  for (const path of ["/", "/login", "/register"]) {
    await page.goto(path);
    await page.waitForURL("**/all");
  }
});

test("a dead session cookie falls through to the login page (no redirect loop)", async ({
  browser,
  baseURL,
}) => {
  // A revoked/garbage session cookie must NOT bounce to /all (whose layout
  // would bounce it straight back) — the proxy validates before redirecting.
  const context = await browser.newContext();
  await context.addCookies([
    {
      name: "session",
      value: "not-a-real-session-token",
      url: baseURL!,
      httpOnly: true,
    },
  ]);
  const page = await context.newPage();
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "Sign in to your account" })).toBeVisible();
  expect(new URL(page.url()).pathname).toBe("/login");
  await context.close();
});

test("tRPC responses are marked uncacheable so a shared cache can't replay them", async ({
  request,
}) => {
  // The register/login forms fetch auth.signupConfig on the client. If a
  // shared cache in front of the app stores that GET, it can replay a stale
  // cross-deploy response (e.g. one missing `euRestricted`), which makes the
  // config-driven UI wrong after a deploy. Every tRPC response must be
  // `no-store`.
  // superjson encodes the procedure's `undefined` input as json:null + a meta
  // marker (matches the real client's batch GET).
  const input = encodeURIComponent(
    JSON.stringify({ "0": { json: null, meta: { values: ["undefined"], v: 1 } } })
  );
  const response = await request.get(`/api/trpc/auth.providers?batch=1&input=${input}`);
  expect(response.status()).toBe(200);
  expect(response.headers()["cache-control"]).toContain("no-store");
});

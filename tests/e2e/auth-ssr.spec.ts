/**
 * E2E tests for the statically-served auth pages (/login, /register).
 *
 * Since issue #1359 these pages are prerendered at build time (no per-request
 * SSR): the login form is baked into the static HTML, while everything
 * config-driven — OAuth provider buttons, the invite-required state, the
 * signup link — is fetched client-side (`auth.signupConfig` / `auth.providers`)
 * and rendered after hydration. (This deliberately reverted the #1328
 * server-side prefetch in exchange for serving the pages statically.) These
 * tests pin both halves: the static HTML contains the form (and no per-request
 * nonce), and the config-driven content still appears and works client-side.
 *
 * The e2e env sets no `ALLOWED_PUBLIC_SIGNUP_PROVIDERS`, so the instance is
 * invite-only (public providers empty); `ALLOWED_SIGNUP_PROVIDERS` defaults to
 * all, so presenting any `?invite=` token renders the full signup form.
 */

import { test, expect } from "@playwright/test";
import { getDb, createPasswordUser, closeTestConnections } from "./helpers";

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
  // Static pages carry no per-request nonce (they get the relaxed static CSP).
  expect(html).not.toContain('nonce="');
});

test("/login hides the signup link on an invite-only instance (client-side config)", async ({
  page,
}) => {
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "Sign in to your account" })).toBeVisible();
  // Wait for the client-side signupConfig query to settle (the OAuth buttons
  // and signup link both depend on it; none of them should appear here).
  await page.waitForLoadState("networkidle");
  await expect(page.getByText("Create one")).toHaveCount(0);
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

test("/register renders the invite-required state on an invite-only instance", async ({ page }) => {
  await page.goto("/register");
  // Config-driven content now renders client-side.
  await expect(page.getByRole("heading", { name: "Invite Required" })).toBeVisible();
  await expect(page.getByText("Create your account")).toHaveCount(0);
});

test("/register with an invite token renders the full signup form", async ({ page }) => {
  await page.goto("/register?invite=any-token");
  // With a token, the full allowlist applies (email is a default provider), so
  // the account form renders instead of the invite-required state.
  await expect(page.getByRole("heading", { name: "Create your account" })).toBeVisible();
  await expect(page.getByText("Invite Required")).toHaveCount(0);
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

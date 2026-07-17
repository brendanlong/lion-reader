/**
 * E2E tests that the auth pages (/login, /register) render their
 * signup-config-driven content in the **initial SSR HTML**, not after a
 * client-side query resolves (issue #1328).
 *
 * The forms depend on `auth.signupConfig` (invite-required state, allowed
 * signup providers) and `auth.providers` (which OAuth buttons to show). Both
 * are static server env, so `(auth)/layout.tsx` prefetches them and hydrates
 * them into the React Query cache. These tests assert against the raw response
 * body (before any hydration/JS runs) so a regression that reverts to the
 * client-only query — which SSRs a "Loading..." placeholder and an empty
 * invite/provider state — fails here.
 *
 * The e2e env sets no `ALLOWED_PUBLIC_SIGNUP_PROVIDERS`, so the instance is
 * invite-only (public providers empty); `ALLOWED_SIGNUP_PROVIDERS` defaults to
 * all, so presenting any `?invite=` token renders the full signup form.
 */

import { test, expect } from "@playwright/test";
import { closeTestConnections } from "./helpers";

test.afterAll(async () => {
  await closeTestConnections();
});

test("/register SSRs the invite-required state, not a loading placeholder", async ({ request }) => {
  const response = await request.get("/register");
  expect(response.status()).toBe(200);
  const html = await response.text();

  // Config-driven content is present in the first paint...
  expect(html).toContain("Invite Required");
  // ...and the client-only loading placeholder is not.
  expect(html).not.toContain("Loading...");
});

test("/register with an invite token SSRs the full signup form", async ({ request }) => {
  const response = await request.get("/register?invite=any-token");
  expect(response.status()).toBe(200);
  const html = await response.text();

  // With a token, the full allowlist applies (email is a default provider), so
  // the account form renders server-side instead of the invite-required state.
  expect(html).toContain("Create your account");
  expect(html).not.toContain("Invite Required");
  expect(html).not.toContain("Loading...");
});

test("/login SSRs signup-config-driven content without a loading flash", async ({ request }) => {
  const response = await request.get("/login");
  expect(response.status()).toBe(200);
  const html = await response.text();

  expect(html).toContain("Sign in to your account");
  expect(html).not.toContain("Loading...");
  // Invite-only instance: the "Create one" signup link is gated off in the SSR
  // HTML (requiresInvite is true), so it must not be present.
  expect(html).not.toContain("Create one");
});

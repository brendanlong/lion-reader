/**
 * E2E test for Settings → Connected Apps (issue #1520).
 *
 * The consent screen promises revocation in Settings, so this drives the whole
 * path a user takes to make good on it: see the authorized app, revoke it, and
 * verify that neither the app's live access token nor an authorization code it
 * was already holding is worth anything afterwards.
 */

import { test, expect } from "@playwright/test";
import { and, eq, isNull } from "drizzle-orm";
import crypto from "node:crypto";
import { getDb, createConfirmedUser, loginAs, closeTestConnections } from "./helpers";
import { oauthAccessTokens, oauthClients, oauthConsentGrants } from "../../src/server/db/schema";
import { createAuthorizationCode } from "../../src/server/oauth/service";
import { generateUuidv7 } from "../../src/lib/uuidv7";

const REDIRECT_URI = "https://example.com/callback";
const CODE_VERIFIER = "e2e-code-verifier-that-is-long-enough-for-rfc-7636";
const CODE_CHALLENGE = crypto
  .createHash("sha256")
  .update(CODE_VERIFIER, "ascii")
  .digest("base64url");

test.afterAll(async () => {
  await closeTestConnections();
});

test("lists an authorized OAuth app and revokes its access", async ({ page, context, baseURL }) => {
  const db = getDb();
  const user = await createConfirmedUser(db);

  const clientId = generateUuidv7();
  const clientName = `E2E Client ${clientId.slice(-6)}`;
  await db.insert(oauthClients).values({
    id: generateUuidv7(),
    clientId,
    name: clientName,
    redirectUris: [REDIRECT_URI],
    scopes: ["mcp"],
    isPublic: true,
  });
  await db.insert(oauthConsentGrants).values({
    id: generateUuidv7(),
    userId: user.id,
    clientId,
    scopes: ["mcp"],
  });
  const accessTokenId = generateUuidv7();
  await db.insert(oauthAccessTokens).values({
    id: accessTokenId,
    tokenHash: crypto.randomBytes(32).toString("hex"),
    clientId,
    userId: user.id,
    scopes: ["mcp"],
    expiresAt: new Date(Date.now() + 3600_000),
  });

  const pendingCode = await createAuthorizationCode({
    clientId,
    userId: user.id,
    redirectUri: REDIRECT_URI,
    scopes: ["mcp"],
    codeChallenge: CODE_CHALLENGE,
  });

  await loginAs(context, user, baseURL!);
  await page.goto("/settings/connected-apps");

  await expect(page.getByText(clientName)).toBeVisible();
  await expect(page.getByText("Read and manage your feeds and articles")).toBeVisible();

  page.on("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Revoke" }).click();

  await expect(page.getByText("You haven't authorized any applications.")).toBeVisible();

  const liveGrants = await db
    .select({ id: oauthConsentGrants.id })
    .from(oauthConsentGrants)
    .where(and(eq(oauthConsentGrants.userId, user.id), isNull(oauthConsentGrants.revokedAt)));
  expect(liveGrants).toHaveLength(0);

  const [token] = await db
    .select({ revokedAt: oauthAccessTokens.revokedAt })
    .from(oauthAccessTokens)
    .where(eq(oauthAccessTokens.id, accessTokenId));
  expect(token.revokedAt).not.toBeNull();

  // The code the client was already holding must be worthless at the real token
  // endpoint — otherwise it trades for a fresh hour of access and a 30-day
  // refresh chain minutes after the user said no.
  const tokenResponse = await page.request.post("/oauth/token", {
    form: {
      grant_type: "authorization_code",
      code: pendingCode,
      redirect_uri: REDIRECT_URI,
      code_verifier: CODE_VERIFIER,
      client_id: clientId,
    },
  });
  expect(tokenResponse.status()).toBe(400);
  expect((await tokenResponse.json()).error).toBe("invalid_grant");
});

test("the token endpoint refuses a code whose consent grant is gone", async ({ page }) => {
  // The revocation sweep burns outstanding codes, so this reaches the token
  // endpoint's own consent check the only way it can be reached in production:
  // a code that outlived the sweep because it was minted alongside it. Revoking
  // just the grant reproduces that state.
  const db = getDb();
  const user = await createConfirmedUser(db);

  const clientId = generateUuidv7();
  await db.insert(oauthClients).values({
    id: generateUuidv7(),
    clientId,
    name: `E2E Client ${clientId.slice(-6)}`,
    redirectUris: [REDIRECT_URI],
    scopes: ["mcp"],
    isPublic: true,
  });
  await db.insert(oauthConsentGrants).values({
    id: generateUuidv7(),
    userId: user.id,
    clientId,
    scopes: ["mcp"],
    revokedAt: new Date(),
  });
  const code = await createAuthorizationCode({
    clientId,
    userId: user.id,
    redirectUri: REDIRECT_URI,
    scopes: ["mcp"],
    codeChallenge: CODE_CHALLENGE,
  });

  const response = await page.request.post("/oauth/token", {
    form: {
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: CODE_VERIFIER,
      client_id: clientId,
    },
  });

  expect(response.status()).toBe(400);
  expect((await response.json()).error).toBe("invalid_grant");
});

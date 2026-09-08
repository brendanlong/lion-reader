/**
 * E2E test for Settings → Connected Apps (issue #1520).
 *
 * The consent screen promises revocation in Settings, so this drives the whole
 * path a user takes to make good on it: see the authorized app, revoke it, and
 * verify the app's live access token is dead afterwards.
 */

import { test, expect } from "@playwright/test";
import { and, eq, isNull } from "drizzle-orm";
import crypto from "node:crypto";
import { getDb, createConfirmedUser, loginAs, closeTestConnections } from "./helpers";
import { oauthAccessTokens, oauthClients, oauthConsentGrants } from "../../src/server/db/schema";
import { generateUuidv7 } from "../../src/lib/uuidv7";

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
    redirectUris: ["https://example.com/callback"],
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
});

/**
 * Integration tests for saving PRIVATE Google Docs via the compat surfaces
 * (Wallabag / MCP), which use `googleDocsAuth: "non-interactive"`.
 *
 * The behavioral change (issue #1165): the non-interactive surfaces attempt the
 * user's stored Google OAuth credentials for a private doc, and — when auth
 * isn't set up — surface a clean, correctly-classified 4xx error with a
 * human-readable message pointing at the web app, instead of the machine-readable
 * NEEDS_* codes the web UI matches (interactive mode) or a generic fetch failure.
 *
 * These tests exercise the auth *gate*, which is reached without any network:
 * the public Google Docs plugin fetch no-ops when no service account is
 * configured (the test env), so `saveArticle` falls straight through to the
 * private-docs OAuth path. The authorized-success path (a real private-doc
 * fetch) needs a live Google token + network, so it isn't covered here.
 */

import { describe, it, expect, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { getHTTPStatusCodeFromError } from "@trpc/server/http";
import { db } from "../../src/server/db";
import { users, oauthAccounts } from "../../src/server/db/schema";
import { generateUuidv7 } from "../../src/lib/uuidv7";
import { saveArticle } from "../../src/server/services/saved";

// A syntactically-valid but non-public Google Docs URL. The plugin's public
// fetch no-ops (no service account), so this always reaches the private path.
const PRIVATE_DOC_URL = "https://docs.google.com/document/d/1PrIvAtEdOcIdAbCdEfGhIjKlMnOpQr/edit";

const createdUserIds: string[] = [];

async function createTestUser(): Promise<string> {
  const userId = generateUuidv7();
  await db.insert(users).values({
    id: userId,
    email: `gdocs-${userId}@test.com`,
    passwordHash: "test-hash",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  createdUserIds.push(userId);
  return userId;
}

async function linkGoogleAccount(userId: string, scopes: string[]): Promise<void> {
  await db.insert(oauthAccounts).values({
    id: generateUuidv7(),
    userId,
    provider: "google",
    providerAccountId: `google-${userId}`,
    accessToken: "test-access-token",
    refreshToken: "test-refresh-token",
    expiresAt: new Date(Date.now() + 3600_000),
    scopes,
  });
}

afterAll(async () => {
  // oauth_accounts cascade-deletes with the user.
  for (const userId of createdUserIds) {
    await db.delete(users).where(eq(users.id, userId));
  }
});

describe("Saving private Google Docs via compat surfaces (issue #1165)", () => {
  it("returns a 401 with a web-app-pointing message when Google is not linked", async () => {
    const userId = await createTestUser();

    let thrown: unknown;
    try {
      await saveArticle(db, userId, {
        url: PRIVATE_DOC_URL,
        googleDocsAuth: "non-interactive",
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(TRPCError);
    const error = thrown as TRPCError;
    // Correctly classified as a client (4xx) error, not a 500.
    expect(getHTTPStatusCodeFromError(error)).toBe(401);
    // Human-readable, not the machine-readable code the web UI matches.
    expect(error.message).not.toBe("NEEDS_GOOGLE_SIGNIN");
    expect(error.message.toLowerCase()).toContain("web app");
    expect(error.message.toLowerCase()).toContain("google");
    // The underlying cause code is preserved for any programmatic consumer.
    expect((error.cause as { code?: string })?.code).toBe("NEEDS_GOOGLE_SIGNIN");
  });

  it("returns a 403 with a web-app-pointing message when Docs scopes are missing", async () => {
    const userId = await createTestUser();
    // Linked, but only the base sign-in scopes — no Docs/Drive access.
    await linkGoogleAccount(userId, ["openid", "email", "profile"]);

    let thrown: unknown;
    try {
      await saveArticle(db, userId, {
        url: PRIVATE_DOC_URL,
        googleDocsAuth: "non-interactive",
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(TRPCError);
    const error = thrown as TRPCError;
    expect(getHTTPStatusCodeFromError(error)).toBe(403);
    expect(error.message).not.toBe("NEEDS_DOCS_PERMISSION");
    expect(error.message.toLowerCase()).toContain("web app");
    expect((error.cause as { code?: string })?.code).toBe("NEEDS_DOCS_PERMISSION");
  });

  it("still throws the machine-readable NEEDS_* codes in interactive mode (web UI contract)", async () => {
    const userId = await createTestUser();

    // No Google account linked → interactive mode surfaces the code verbatim.
    await expect(
      saveArticle(db, userId, {
        url: PRIVATE_DOC_URL,
        googleDocsAuth: "interactive",
      })
    ).rejects.toMatchObject({ message: "NEEDS_GOOGLE_SIGNIN" });

    // Missing scopes → NEEDS_DOCS_PERMISSION verbatim.
    await linkGoogleAccount(userId, ["openid", "email", "profile"]);
    await expect(
      saveArticle(db, userId, {
        url: PRIVATE_DOC_URL,
        googleDocsAuth: "interactive",
      })
    ).rejects.toMatchObject({ message: "NEEDS_DOCS_PERMISSION" });
  });
});

/**
 * The native app's API surface, exercised through the real REST handler
 * (`/api/v1/...`) with a Bearer OAuth token, the way the app calls it.
 *
 * Covers the token gate (only the first-party client's `/api/v1`-audience token
 * is accepted, and only on endpoints that opted in), the authorize endpoint's
 * audience binding, and the app-only endpoints (`sync.changes`,
 * `entries.getMany`, `entries.setStarredMany`, clock-skew rebasing).
 */

import { describe, it, expect, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "../../src/server/db";
import {
  oauthAuthorizationCodes,
  subscriptions,
  userEntries,
  users,
} from "../../src/server/db/schema";
import { createApiToken } from "../../src/server/auth/api-token";
import { GET as eventsGet } from "../../src/app/api/v1/events/route";
import { createSession } from "../../src/server/auth/session";
import { createTokens, recordConsent } from "../../src/server/oauth/service";
import {
  APP_CLIENT_ID,
  getAppRedirectUri,
  getAppResourceIdentifier,
} from "../../src/server/oauth/app-client";
import { getResourceIdentifier } from "../../src/server/oauth/config";
import { OAUTH_SCOPES } from "../../src/server/oauth/utils";
import { deleteSavedArticle } from "../../src/server/services/saved";
import { getOrCreateSavedFeed } from "../../src/server/feed/saved-feed";
import { GET as restHandler } from "../../src/app/api/v1/[...path]/route";
import { GET as authorizeGet } from "../../src/app/(spa)/oauth/authorize/route";
import {
  createTestEntry,
  createTestFeed,
  createTestOAuthClient,
  createTestSubscription,
  createTestUser,
} from "./helpers";

const API = "http://localhost:3000/api/v1";
// Any valid S256 challenge; the tests never redeem the code.
const CODE_CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

const createdUserIds: string[] = [];

afterAll(async () => {
  for (const userId of createdUserIds) {
    await db.delete(users).where(eq(users.id, userId));
  }
});

async function createUser(): Promise<string> {
  const userId = await createTestUser({ emailPrefix: "app-api" });
  createdUserIds.push(userId);
  return userId;
}

async function appToken(userId: string): Promise<string> {
  const tokens = await createTokens({
    clientId: APP_CLIENT_ID,
    userId,
    scopes: [OAUTH_SCOPES.READER_FULL_ACCESS],
    resource: getAppResourceIdentifier(),
  });
  return tokens.accessToken;
}

async function rest(
  token: string,
  method: "GET" | "POST",
  path: string,
  body?: unknown
): Promise<Response> {
  return restHandler(
    new Request(`${API}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
  );
}

async function subscribedEntries(userId: string, count: number): Promise<string[]> {
  const feedId = await createTestFeed();
  await createTestSubscription(userId, feedId);
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    ids.push(await createTestEntry(feedId, { userIds: [userId] }));
  }
  return ids;
}

describe("app token authentication", () => {
  it("accepts the app's token on reader endpoints", async () => {
    const userId = await createUser();
    const res = await rest(await appToken(userId), "GET", "/entries");
    expect(res.status).toBe(200);
  });

  it("rejects the app's token on session-only endpoints", async () => {
    const userId = await createUser();
    const res = await rest(await appToken(userId), "GET", "/users/me/sessions");
    expect(res.status).toBe(403);
  });

  it("rejects an MCP-audience token, even with reader:full-access", async () => {
    const userId = await createUser();
    const { accessToken } = await createTokens({
      clientId: APP_CLIENT_ID,
      userId,
      scopes: [OAUTH_SCOPES.READER_FULL_ACCESS],
      resource: getResourceIdentifier(),
    });
    const res = await rest(accessToken, "GET", "/entries");
    expect(res.status).toBe(401);
  });

  it("rejects another client's token bound to the app audience", async () => {
    const userId = await createUser();
    const clientId = await createTestOAuthClient({ scopes: ["reader:full-access"] });
    const { accessToken } = await createTokens({
      clientId,
      userId,
      scopes: [OAUTH_SCOPES.READER_FULL_ACCESS],
      resource: getAppResourceIdentifier(),
    });
    const res = await rest(accessToken, "GET", "/entries");
    expect(res.status).toBe(401);
  });

  it("rejects an mcp API token on app-only endpoints", async () => {
    const userId = await createUser();
    const { token } = await createApiToken(userId, ["mcp"]);
    expect((await rest(token, "GET", "/sync/changes")).status).toBe(403);
    expect((await rest(token, "POST", "/entries/batch", { ids: [userId] })).status).toBe(403);
    expect((await rest(token, "POST", "/entries/mark-all-read", {})).status).toBe(403);
  });

  it("opens the SSE stream for the app's token only", async () => {
    const userId = await createUser();
    const events = (token: string) =>
      eventsGet(new Request(`${API}/events`, { headers: { authorization: `Bearer ${token}` } }));

    const accepted = await events(await appToken(userId));
    expect(accepted.status).toBe(200);
    await accepted.body?.cancel();

    const { accessToken: mcpAudience } = await createTokens({
      clientId: APP_CLIENT_ID,
      userId,
      scopes: [OAUTH_SCOPES.READER_FULL_ACCESS],
      resource: getResourceIdentifier(),
    });
    expect((await events(mcpAudience)).status).toBe(401);
    const { token: apiToken } = await createApiToken(userId, ["mcp"]);
    expect((await events(apiToken)).status).toBe(401);
  });

  it("rejects the app's token without reader:full-access", async () => {
    const userId = await createUser();
    const { accessToken } = await createTokens({
      clientId: APP_CLIENT_ID,
      userId,
      scopes: [OAUTH_SCOPES.MCP],
      resource: getAppResourceIdentifier(),
    });
    const res = await rest(accessToken, "GET", "/entries");
    expect(res.status).toBe(401);
  });
});

describe("/oauth/authorize audience binding", () => {
  async function authorize(userId: string, params: Record<string, string>): Promise<URL> {
    const { token } = await createSession(db, { userId });
    const url = new URL("http://localhost:3000/oauth/authorize");
    for (const [key, value] of Object.entries({
      response_type: "code",
      code_challenge: CODE_CHALLENGE,
      code_challenge_method: "S256",
      ...params,
    })) {
      url.searchParams.set(key, value);
    }
    const res = await authorizeGet(
      new NextRequest(url, { headers: { cookie: `session=${token}` } })
    );
    return new URL(res.headers.get("location") ?? "");
  }

  it("binds the app client's codes to the /api/v1 audience", async () => {
    const userId = await createUser();
    await recordConsent(userId, APP_CLIENT_ID, [OAUTH_SCOPES.READER_FULL_ACCESS]);

    const location = await authorize(userId, {
      client_id: APP_CLIENT_ID,
      redirect_uri: getAppRedirectUri(),
      scope: OAUTH_SCOPES.READER_FULL_ACCESS,
    });
    expect(location.origin + location.pathname).toBe(getAppRedirectUri());
    expect(location.searchParams.get("code")).toBeTruthy();

    const [code] = await db
      .select({ resource: oauthAuthorizationCodes.resource })
      .from(oauthAuthorizationCodes)
      .where(
        and(
          eq(oauthAuthorizationCodes.userId, userId),
          eq(oauthAuthorizationCodes.clientId, APP_CLIENT_ID)
        )
      );
    expect(code.resource).toBe(getAppResourceIdentifier());
  });

  it("refuses the /api/v1 audience to any other client", async () => {
    const userId = await createUser();
    const clientId = await createTestOAuthClient({ scopes: ["reader:full-access"] });
    await recordConsent(userId, clientId, [OAUTH_SCOPES.READER_FULL_ACCESS]);

    const location = await authorize(userId, {
      client_id: clientId,
      redirect_uri: "https://example.com/callback",
      scope: OAUTH_SCOPES.READER_FULL_ACCESS,
      resource: getAppResourceIdentifier(),
    });
    expect(location.searchParams.get("error")).toBe("invalid_target");
  });
});

describe("sync.changes", () => {
  it("bootstraps cursors, then returns new changes with the next cursors", async () => {
    const userId = await createUser();
    const token = await appToken(userId);
    const [existing] = await subscribedEntries(userId, 1);

    const bootstrap = await (await rest(token, "GET", "/sync/changes")).json();
    expect(bootstrap.events).toEqual([]);
    expect(bootstrap.resyncRequired).toBe(false);
    expect(bootstrap.cursors.entries).toBeTruthy();
    expect(bootstrap.cursors.deletions).toBeTruthy();

    await db
      .update(userEntries)
      .set({ read: true, updatedAt: new Date(Date.now() + 1000) })
      .where(and(eq(userEntries.userId, userId), eq(userEntries.entryId, existing)));

    const params = new URLSearchParams(bootstrap.cursors);
    const delta = await (await rest(token, "GET", `/sync/changes?${params}`)).json();
    const stateEvents = delta.events.filter(
      (e: { type: string; entryId?: string }) =>
        e.type === "entry_state_changed" && e.entryId === existing
    );
    expect(stateEvents).toHaveLength(1);
    expect(stateEvents[0].read).toBe(true);
    expect(delta.cursors.entriesAfterId).toBe(existing);

    const again = await (
      await rest(token, "GET", `/sync/changes?${new URLSearchParams(delta.cursors)}`)
    ).json();
    expect(again.events).toEqual([]);
  });

  it("reports deleted saved articles as tombstones", async () => {
    const userId = await createUser();
    const token = await appToken(userId);
    const savedFeed = await getOrCreateSavedFeed(db, userId);
    const articleId = await createTestEntry(savedFeed, { type: "saved", userIds: [userId] });

    const bootstrap = await (await rest(token, "GET", "/sync/changes")).json();
    expect(await deleteSavedArticle(db, userId, articleId)).toBe(true);

    const params = new URLSearchParams(bootstrap.cursors);
    const delta = await (await rest(token, "GET", `/sync/changes?${params}`)).json();
    expect(delta.deletions.map((d: { entryId: string }) => d.entryId)).toEqual([articleId]);

    const again = await (
      await rest(token, "GET", `/sync/changes?${new URLSearchParams(delta.cursors)}`)
    ).json();
    expect(again.deletions).toEqual([]);
  });

  it("advances the deletions cursor even when nothing was deleted", async () => {
    const userId = await createUser();
    const token = await appToken(userId);
    const bootstrap = await (await rest(token, "GET", "/sync/changes")).json();
    // Nearly at the retention horizon.
    const old = new Date(Date.now() - 59 * 24 * 60 * 60 * 1000).toISOString();

    const delta = await (
      await rest(
        token,
        "GET",
        `/sync/changes?${new URLSearchParams({ ...bootstrap.cursors, deletions: old })}`
      )
    ).json();

    expect(delta.resyncRequired).toBe(false);
    expect(new Date(delta.cursors.deletions).getTime()).toBeGreaterThan(Date.now() - 5 * 60 * 1000);
  });

  it("reports an entry that left the user's view through a state change", async () => {
    const userId = await createUser();
    const token = await appToken(userId);
    const feedId = await createTestFeed();
    const subscriptionId = await createTestSubscription(userId, feedId);
    const entryId = await createTestEntry(feedId, { userIds: [userId] });
    await rest(token, "POST", "/entries/starred", { entries: [{ id: entryId }], starred: true });
    await db
      .update(subscriptions)
      .set({ unsubscribedAt: new Date() })
      .where(eq(subscriptions.id, subscriptionId));

    const bootstrap = await (await rest(token, "GET", "/sync/changes")).json();
    // Unstarring an entry of an unsubscribed feed hides it.
    await rest(token, "POST", "/entries/starred", { entries: [{ id: entryId }], starred: false });

    const delta = await (
      await rest(token, "GET", `/sync/changes?${new URLSearchParams(bootstrap.cursors)}`)
    ).json();
    expect(delta.deletions.map((d: { entryId: string }) => d.entryId)).toContain(entryId);
  });

  it("requires a resync when the deletions cursor predates tombstone retention", async () => {
    const userId = await createUser();
    const token = await appToken(userId);
    const bootstrap = await (await rest(token, "GET", "/sync/changes")).json();
    const params = new URLSearchParams({
      ...bootstrap.cursors,
      deletions: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString(),
    });
    const delta = await (await rest(token, "GET", `/sync/changes?${params}`)).json();
    expect(delta.resyncRequired).toBe(true);
  });
});

describe("entries.getMany", () => {
  it("returns full entries in request order, omitting ids the user can't see", async () => {
    const userId = await createUser();
    const otherUserId = await createUser();
    const token = await appToken(userId);
    const [a, b] = await subscribedEntries(userId, 2);
    const [foreign] = await subscribedEntries(otherUserId, 1);

    const res = await rest(token, "POST", "/entries/batch", { ids: [b, foreign, a] });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.entries.map((e: { id: string }) => e.id)).toEqual([b, a]);
  });
});

describe("entries.setStarredMany", () => {
  it("applies per-entry timestamps last-write-wins", async () => {
    const userId = await createUser();
    const token = await appToken(userId);
    const [a, b] = await subscribedEntries(userId, 2);

    await rest(token, "POST", "/entries/starred", {
      entries: [{ id: a }, { id: b }],
      starred: true,
    });
    const res = await rest(token, "POST", "/entries/starred", {
      entries: [
        // Stamped before the star above: loses.
        { id: a, changedAt: new Date(Date.now() - 60 * 1000).toISOString() },
        // Stamped now: wins.
        { id: b },
      ],
      starred: false,
    });
    const body = await res.json();
    const byId = Object.fromEntries(
      body.entries.map((e: { id: string; starred: boolean }) => [e.id, e.starred])
    );
    expect(byId).toEqual({ [a]: true, [b]: false });
  });
});

describe("clock-skew rebasing", () => {
  it("shifts changedAt by the client's clock offset", async () => {
    const userId = await createUser();
    const token = await appToken(userId);
    const [entryId] = await subscribedEntries(userId, 1);

    // The client's clock is an hour fast: it marked the entry "now" by its
    // clock, which is an hour in the server's future.
    const clientNow = new Date(Date.now() + 60 * 60 * 1000);
    await rest(token, "POST", "/entries/mark-read", {
      entries: [{ id: entryId, changedAt: clientNow.toISOString() }],
      read: true,
      clientSentAt: clientNow.toISOString(),
    });

    const [row] = await db
      .select({ readChangedAt: userEntries.readChangedAt })
      .from(userEntries)
      .where(and(eq(userEntries.userId, userId), eq(userEntries.entryId, entryId)));
    expect(Math.abs(row.readChangedAt!.getTime() - Date.now())).toBeLessThan(60 * 1000);
  });
});

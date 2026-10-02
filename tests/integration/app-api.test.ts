/**
 * The native app's API surface, exercised through the real REST handler
 * (`/api/v1/...`) with a Bearer OAuth token, the way the app calls it.
 *
 * Covers the token gate (only the first-party client's `/api/v1`-audience token
 * is accepted, and only on endpoints that opted in), the authorize endpoint's
 * audience binding, and the app-only endpoints (`sync.changes`,
 * `entries.getMany`, `entries.setStarredMany`, clock-skew rebasing, summaries,
 * saving shared links, cloud voices).
 */

import { describe, it, expect, afterAll, afterEach, beforeAll, vi } from "vitest";
import Redis from "ioredis";
import { NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "../../src/server/db";
import {
  entrySummaries,
  oauthAuthorizationCodes,
  sessions,
  subscriptions,
  userEntries,
  users,
} from "../../src/server/db/schema";
import { createApiToken } from "../../src/server/auth/api-token";
import { RATE_LIMIT_CONFIGS } from "../../src/server/rate-limit";
import { generateUuidv7 } from "../../src/lib/uuidv7";
import { CURRENT_PROMPT_VERSION } from "../../src/server/services/summarization";
import { AI_PROVIDER_ENV_KEYS } from "../../src/server/services/ai-providers";
import { GET as eventsGet } from "../../src/app/api/v1/events/route";
import { POST as speechPost } from "../../src/app/api/v1/narration/speech/route";
import { MAX_CLOUD_SPEECH_CHARS } from "../../src/lib/narration/constants";
import { createSession, revokeSession } from "../../src/server/auth/session";
import {
  createTokens,
  recordConsent,
  revokeUserClientTokens,
} from "../../src/server/oauth/service";
import {
  APP_CLIENT_ID,
  getAppRedirectUri,
  getDebugAppRedirectUri,
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

describe("SSE credential re-check", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // Whether the stream ends within a few heartbeats of `revoke` running.
  async function streamEndsAfterHeartbeats(
    body: ReadableStream<Uint8Array>,
    revoke: () => Promise<void>
  ): Promise<boolean> {
    const reader = body.getReader();
    // The initial heartbeat.
    expect((await reader.read()).done).toBe(false);
    await revoke();
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(30_000);
    }
    for (;;) {
      const read = await Promise.race([
        reader.read(),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 2_000)),
      ]);
      if (read === null) {
        await reader.cancel();
        return false;
      }
      if (read.done) return true;
    }
  }

  it("closes a session's stream once the session is revoked", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const userId = await createUser();
    const { sessionId, token } = await createSession(db, { userId });
    const res = await eventsGet(
      new Request(`${API}/events`, { headers: { cookie: `session=${token}` } })
    );
    expect(res.status).toBe(200);
    const ended = await streamEndsAfterHeartbeats(res.body!, async () => {
      await revokeSession(sessionId);
    });
    expect(ended).toBe(true);
  });

  it("closes a session's stream once the session expires", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const userId = await createUser();
    const { sessionId, token } = await createSession(db, { userId });
    const res = await eventsGet(
      new Request(`${API}/events`, { headers: { cookie: `session=${token}` } })
    );
    expect(res.status).toBe(200);
    const ended = await streamEndsAfterHeartbeats(res.body!, async () => {
      await db
        .update(sessions)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(sessions.id, sessionId));
    });
    expect(ended).toBe(true);
  });

  it("closes an app token's stream once the token is revoked", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const userId = await createUser();
    const res = await eventsGet(
      new Request(`${API}/events`, {
        headers: { authorization: `Bearer ${await appToken(userId)}` },
      })
    );
    expect(res.status).toBe(200);
    const ended = await streamEndsAfterHeartbeats(res.body!, () =>
      revokeUserClientTokens(userId, APP_CLIENT_ID)
    );
    expect(ended).toBe(true);
  });

  it("keeps the stream open while the credential is valid", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const userId = await createUser();
    const { token } = await createSession(db, { userId });
    const res = await eventsGet(
      new Request(`${API}/events`, { headers: { cookie: `session=${token}` } })
    );
    expect(res.status).toBe(200);
    const ended = await streamEndsAfterHeartbeats(res.body!, async () => {});
    expect(ended).toBe(false);
  });
});

describe("GET /auth/me", () => {
  it("tells the app which account its token belongs to", async () => {
    const userId = await createUser();
    const res = await rest(await appToken(userId), "GET", "/auth/me");
    expect(res.status).toBe(200);
    expect((await res.json()).user.id).toBe(userId);
  });

  it("works before signup confirmation, unlike the reader endpoints", async () => {
    const userId = await createTestUser({
      emailPrefix: "app-api-unconfirmed",
      tosAgreedAt: null,
      privacyPolicyAgreedAt: null,
      notEuAgreedAt: null,
    });
    createdUserIds.push(userId);
    const token = await appToken(userId);

    const me = await rest(token, "GET", "/auth/me");
    expect(me.status).toBe(200);
    expect((await me.json()).user.tosAgreedAt).toBeNull();
    const entries = await rest(token, "GET", "/entries");
    expect(entries.status).toBe(403);
    expect((await entries.json()).message).toBe(
      "You must complete signup before accessing this resource"
    );
  });

  it("still serves browser sessions, confirmed or not", async () => {
    for (const confirmed of [true, false]) {
      const userId = await createTestUser({
        emailPrefix: "app-api-session",
        ...(confirmed
          ? {}
          : { tosAgreedAt: null, privacyPolicyAgreedAt: null, notEuAgreedAt: null }),
      });
      createdUserIds.push(userId);
      const { token } = await createSession(db, { userId });
      const res = await rest(token, "GET", "/auth/me");
      expect(res.status).toBe(200);
      expect((await res.json()).user.id).toBe(userId);
    }
  });

  it("stays closed to MCP API tokens", async () => {
    const userId = await createUser();
    const { token } = await createApiToken(userId, ["mcp"]);
    expect((await rest(token, "GET", "/auth/me")).status).toBe(403);
  });
});

describe("/oauth/authorize audience binding", () => {
  async function authorize(userId: string, params: Record<string, string>): Promise<URL> {
    const res = await authorizeResponse(userId, params);
    return new URL(res.headers.get("location") ?? "");
  }

  async function authorizeResponse(userId: string, params: Record<string, string>) {
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
    return authorizeGet(new NextRequest(url, { headers: { cookie: `session=${token}` } }));
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

  it("sends the debug app's codes to its own path, once it has a key", async () => {
    const userId = await createUser();
    await recordConsent(userId, APP_CLIENT_ID, [OAUTH_SCOPES.READER_FULL_ACCESS]);
    const issuer = process.env.NEXT_PUBLIC_APP_URL;
    // A deployed server: a dev one on localhost takes the path regardless.
    process.env.NEXT_PUBLIC_APP_URL = "https://reader.example.com";
    const request = () => ({
      client_id: APP_CLIENT_ID,
      redirect_uri: getDebugAppRedirectUri(),
      scope: OAUTH_SCOPES.READER_FULL_ACCESS,
    });
    try {
      // No app can claim the path, so nothing may be sent there.
      const refused = await authorizeResponse(userId, request());
      expect(refused.headers.get("location")).toBeNull();

      process.env.ANDROID_DEBUG_APP_CERT_SHA256 = Array(32).fill("CC").join(":");
      const location = await authorize(userId, request());
      expect(location.origin + location.pathname).toBe(getDebugAppRedirectUri());
      expect(location.searchParams.get("code")).toBeTruthy();
    } finally {
      delete process.env.ANDROID_DEBUG_APP_CERT_SHA256;
      if (issuer === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
      else process.env.NEXT_PUBLIC_APP_URL = issuer;
    }
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

  it("tells the app when read state changed, in sync and every entry read", async () => {
    const userId = await createUser();
    const token = await appToken(userId);
    const [existing] = await subscribedEntries(userId, 1);
    const bootstrap = await (await rest(token, "GET", "/sync/changes")).json();

    const changedAt = new Date(Date.now() - 1000).toISOString();
    const marked = await (
      await rest(token, "POST", "/entries/mark-read", {
        entries: [{ id: existing, changedAt }],
        read: true,
      })
    ).json();
    expect(new Date(marked.entries[0].readChangedAt).toISOString()).toBe(changedAt);

    const delta = await (
      await rest(token, "GET", `/sync/changes?${new URLSearchParams(bootstrap.cursors)}`)
    ).json();
    const state = delta.events.find(
      (e: { type: string; entryId?: string }) =>
        e.type === "entry_state_changed" && e.entryId === existing
    );
    expect(new Date(state.readChangedAt).toISOString()).toBe(changedAt);

    const list = await (await rest(token, "GET", "/entries?sortBy=readChanged")).json();
    expect(list.items.map((item: { id: string }) => item.id)).toEqual([existing]);
    expect(new Date(list.items[0].readChangedAt).toISOString()).toBe(changedAt);

    const batch = await (await rest(token, "POST", "/entries/batch", { ids: [existing] })).json();
    expect(new Date(batch.entries[0].readChangedAt).toISOString()).toBe(changedAt);
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

describe("GET /entries/count", () => {
  it("reaches entries.count rather than GET /entries/{id}", async () => {
    const userId = await createUser();
    await subscribedEntries(userId, 2);
    const res = await rest(await appToken(userId), "GET", "/entries/count?unreadOnly=true");
    expect(res.status).toBe(200);
    expect((await res.json()).unread).toBe(2);
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

describe("summaries", () => {
  // Summaries are available only with an AI provider key, so the tests control
  // the server keys rather than inherit whatever the environment has.
  const savedKeys = new Map<string, string | undefined>();
  beforeAll(() => {
    for (const name of Object.values(AI_PROVIDER_ENV_KEYS)) {
      savedKeys.set(name, process.env[name]);
      delete process.env[name];
    }
  });
  afterEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
  });
  afterAll(() => {
    for (const [name, value] of savedKeys) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it("lets the app generate (here: read the cached) summary of an entry", async () => {
    // Never called: the cached summary is returned first.
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-server-key";
    const userId = await createUser();
    const [entryId] = await subscribedEntries(userId, 1);
    await db.insert(entrySummaries).values({
      id: generateUuidv7(),
      userId,
      // createTestEntry's content hash; the summary cache is keyed off it.
      contentHash: `hash-${entryId}`,
      summaryText: "<p>A short summary.</p>",
      modelId: "claude-test",
      promptVersion: CURRENT_PROMPT_VERSION,
      generatedAt: new Date(),
      createdAt: new Date(),
    });

    const res = await rest(await appToken(userId), "POST", "/summarization/generate", {
      entryId,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.summary).toContain("A short summary.");
    expect(body.cached).toBe(true);
  });

  it("tells the app whether summaries are available", async () => {
    const token = await appToken(await createUser());
    const available = async () =>
      (await (await rest(token, "GET", "/summarization/available")).json()).available;

    expect(await available()).toBe(false);
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-server-key";
    expect(await available()).toBe(true);
  });

  it("keeps summary settings session-only", async () => {
    const userId = await createUser();
    const res = await rest(await appToken(userId), "GET", "/summarization/models");
    expect(res.status).toBe(403);
  });

  it("rejects an mcp API token", async () => {
    const userId = await createUser();
    const [entryId] = await subscribedEntries(userId, 1);
    const { token } = await createApiToken(userId, ["mcp"]);
    expect((await rest(token, "GET", "/summarization/available")).status).toBe(403);
    expect((await rest(token, "POST", "/summarization/generate", { entryId })).status).toBe(403);
  });
});

describe("POST /saved", () => {
  it("lets the app save a shared link", async () => {
    const userId = await createUser();
    const paragraph = "<p>Shared from another app, with enough text to read as an article.</p>";
    const res = await rest(await appToken(userId), "POST", "/saved", {
      url: "https://example.com/shared-article",
      // Supplied, so the server doesn't fetch the page.
      html: `<html><head><title>Shared Article</title></head><body><article>${paragraph.repeat(8)}</article></body></html>`,
    });
    expect(res.status).toBe(200);
    expect((await res.json()).article.title).toBe("Shared Article");
  });

  it("explains a private Google Doc in words, not the web UI's NEEDS_* codes", async () => {
    const userId = await createUser();
    // Not public, and no Google account linked: stops at the auth gate, no network.
    const res = await rest(await appToken(userId), "POST", "/saved", {
      url: "https://docs.google.com/document/d/1PrIvAtEdOcIdAbCdEfGhIjKlMnOpQr/edit",
    });
    const body = await res.json();
    expect(res.status).toBe(401);
    expect(body.message).not.toBe("NEEDS_GOOGLE_SIGNIN");
    expect(body.message.toLowerCase()).toContain("web app");
    // How the app tells this 401 from an expired token (it refreshes only for
    // one without a code).
    expect(body.data.appErrorCode).toBe("NEEDS_GOOGLE_SIGNIN");
  });
});

describe("cloud voices", () => {
  // With no AI provider key there are no cloud voices; that's enough to show
  // the app gets past the token gate (no network either way).
  const savedKeys = new Map<string, string | undefined>();
  beforeAll(() => {
    for (const name of Object.values(AI_PROVIDER_ENV_KEYS)) {
      savedKeys.set(name, process.env[name]);
      delete process.env[name];
    }
  });
  afterAll(() => {
    for (const [name, value] of savedKeys) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it("lets the app list voice models and ask for speech", async () => {
    const userId = await createUser();
    const token = await appToken(userId);

    const models = await rest(token, "GET", "/narration/voice-models");
    expect(models.status).toBe(200);
    expect((await models.json()).models).toEqual([]);

    const speech = await rest(token, "POST", "/narration/synthesize", {
      model: null,
      voice: null,
      text: "Hello.",
    });
    // Past the gate: rejected for the missing key, not the token.
    expect(speech.status).toBe(400);
    expect((await speech.json()).message).toContain("OpenRouter API key");
    // And charged to the user's speech bucket, the one the web draws on too
    // (short texts pay the 200-character floor).
    const redis = new Redis(process.env.REDIS_URL!);
    try {
      const left = Number(await redis.hget(`rate_limit:speech:user:${userId}`, "tokens"));
      expect(left).toBeCloseTo(RATE_LIMIT_CONFIGS.speech.capacity - 200, -2);
    } finally {
      await redis.quit();
    }
  });

  it("rejects an mcp API token", async () => {
    const { token } = await createApiToken(await createUser(), ["mcp"]);
    expect((await rest(token, "GET", "/narration/voice-models")).status).toBe(403);
    expect(
      (await rest(token, "POST", "/narration/synthesize", { model: null, voice: null, text: "Hi" }))
        .status
    ).toBe(403);
  });
});

describe("streamed speech", () => {
  // No provider key, so a valid request reaches the provider check and stops
  // there: these test the route's gates, not a provider.
  const savedKeys = new Map<string, string | undefined>();
  beforeAll(() => {
    for (const name of Object.values(AI_PROVIDER_ENV_KEYS)) {
      savedKeys.set(name, process.env[name]);
      delete process.env[name];
    }
  });
  afterAll(() => {
    for (const [name, value] of savedKeys) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  function speech(
    headers: Record<string, string>,
    body: unknown = { model: null, voice: null, text: "Hello." }
  ) {
    return speechPost(
      new Request(`${API}/narration/speech`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: typeof body === "string" ? body : JSON.stringify(body),
      })
    );
  }

  it("takes the app's token and the web's session", async () => {
    const userId = await createUser();
    const { token } = await createSession(db, { userId });
    for (const headers of [
      { authorization: `Bearer ${await appToken(userId)}` },
      { cookie: `session=${token}` },
    ]) {
      const res = await speech(headers);
      // Past the gates: rejected for the missing provider key.
      expect(res.status).toBe(400);
      expect((await res.json()).message).toContain("OpenRouter API key");
    }
  });

  it("charges the speech bucket the tRPC endpoint uses", async () => {
    const userId = await createUser();
    await speech({ authorization: `Bearer ${await appToken(userId)}` });
    const redis = new Redis(process.env.REDIS_URL!);
    try {
      const left = Number(await redis.hget(`rate_limit:speech:user:${userId}`, "tokens"));
      expect(left).toBeCloseTo(RATE_LIMIT_CONFIGS.speech.capacity - 200, -2);
    } finally {
      await redis.quit();
    }
  });

  it("refuses requests without a credential, or with another client's token", async () => {
    const userId = await createUser();
    const { token: mcpToken } = await createApiToken(userId, ["mcp"]);
    expect((await speech({})).status).toBe(401);
    expect((await speech({ authorization: `Bearer ${mcpToken}` })).status).toBe(401);
  });

  it("refuses users who haven't confirmed signup", async () => {
    const userId = await createUser();
    await db.update(users).set({ tosAgreedAt: null }).where(eq(users.id, userId));
    const { token } = await createSession(db, { userId });
    const res = await speech({ cookie: `session=${token}` });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("SIGNUP_CONFIRMATION_REQUIRED");
  });

  it("takes only JSON, so a cross-site form can't post to it", async () => {
    const userId = await createUser();
    const { token } = await createSession(db, { userId });
    const res = await speech(
      { cookie: `session=${token}`, "content-type": "application/x-www-form-urlencoded" },
      "text=Hello"
    );
    expect(res.status).toBe(415);
  });

  it("validates the request", async () => {
    const auth = { authorization: `Bearer ${await appToken(await createUser())}` };
    expect((await speech(auth, "{")).status).toBe(400);
    expect((await speech(auth, { model: null, voice: null, text: "" })).status).toBe(400);
    expect(
      (
        await speech(auth, {
          model: null,
          voice: null,
          text: "x".repeat(MAX_CLOUD_SPEECH_CHARS + 1),
        })
      ).status
    ).toBe(400);
  });

  it("is rate limited by characters", async () => {
    const auth = { authorization: `Bearer ${await appToken(await createUser())}` };
    const text = "x".repeat(MAX_CLOUD_SPEECH_CHARS);
    const requests = RATE_LIMIT_CONFIGS.speech.capacity / MAX_CLOUD_SPEECH_CHARS + 1;
    let last: Response | null = null;
    for (let i = 0; i < requests; i++)
      last = await speech(auth, { model: null, voice: null, text });
    expect(last?.status).toBe(429);
    expect(last?.headers.get("retry-after")).not.toBeNull();
  });
});

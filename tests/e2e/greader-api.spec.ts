/**
 * Route-level tests for the Google Reader compatibility API
 * (`src/app/api/greader.php/**`).
 *
 * The Google Reader HTTP surface — ClientLogin, GoogleLogin bearer auth,
 * response formatting, status codes — has no unit/integration coverage. This
 * suite exercises the real server over HTTP.
 *
 * Regression guard for #1018: `requireAuth` used to `throw` a `Response`, which
 * Next.js App Router surfaces as a 500 instead of the intended 401. These tests
 * assert 401 (not 500) for every unauthenticated protected endpoint.
 */

import { test, expect, type APIRequestContext } from "@playwright/test";
import {
  getDb,
  createPasswordUser,
  createSubscribedFeed,
  createUnreadEntry,
  closeTestConnections,
  type TestPasswordUser,
  type TestFeed,
} from "./helpers";

const CLIENT_LOGIN_PATH = "/api/greader.php/accounts/ClientLogin";
const API_BASE = "/api/greader.php/reader/api/0";

/** Protected GET endpoints that must reject unauthenticated requests with 401. */
const PROTECTED_GET_ENDPOINTS = [
  `${API_BASE}/user-info`,
  `${API_BASE}/unread-count`,
  `${API_BASE}/subscription/list`,
  `${API_BASE}/tag/list`,
  `${API_BASE}/token`,
  `${API_BASE}/stream/items/ids?s=user/-/state/com.google/reading-list`,
];

interface SeededUser {
  user: TestPasswordUser;
  feed: TestFeed;
}

let seeded: SeededUser | undefined;

/** A confirmed password user with a subscribed feed + one unread entry. */
async function getSeeded(): Promise<SeededUser> {
  if (!seeded) {
    const db = getDb();
    const user = await createPasswordUser(db);
    const feed = await createSubscribedFeed(db, user.id);
    await createUnreadEntry(db, { feedId: feed.feedId, userId: user.id, title: "GReader entry" });
    seeded = { user, feed };
  }
  return seeded;
}

/** Runs ClientLogin and returns the `Auth=` token. */
async function clientLogin(request: APIRequestContext, user: TestPasswordUser): Promise<string> {
  const res = await request.post(CLIENT_LOGIN_PATH, {
    form: { Email: user.email, Passwd: user.password },
  });
  expect(res.status()).toBe(200);
  const text = await res.text();
  const match = text.match(/^Auth=(.+)$/m);
  expect(match, `ClientLogin response missing Auth token:\n${text}`).not.toBeNull();
  return match![1];
}

let sharedToken: string | undefined;

/**
 * Logs in once and memoizes the auth token. The `expensive` per-IP rate-limit
 * bucket (capacity 10, refill 1/s) is shared across both compat login
 * endpoints, so happy-path tests reuse a single token rather than logging in
 * on every case.
 */
async function getToken(request: APIRequestContext): Promise<string> {
  if (!sharedToken) {
    const { user } = await getSeeded();
    sharedToken = await clientLogin(request, user);
  }
  return sharedToken;
}

/** GoogleLogin authorization header for a token. */
function authHeader(token: string): Record<string, string> {
  return { Authorization: `GoogleLogin auth=${token}` };
}

test.afterAll(async () => {
  await closeTestConnections();
});

test.describe("Google Reader API auth", () => {
  test("protected endpoints return 401 (not 500) without a token", async ({ request }) => {
    for (const endpoint of PROTECTED_GET_ENDPOINTS) {
      const res = await request.get(endpoint);
      expect(res.status(), `GET ${endpoint} without auth`).toBe(401);
    }
  });

  test("protected endpoints return 401 with a garbage token", async ({ request }) => {
    for (const endpoint of PROTECTED_GET_ENDPOINTS) {
      const res = await request.get(endpoint, { headers: authHeader("not-a-real-token") });
      expect(res.status(), `GET ${endpoint} with garbage token`).toBe(401);
    }
  });

  test("ClientLogin with wrong password returns 401", async ({ request }) => {
    const { user } = await getSeeded();
    const res = await request.post(CLIENT_LOGIN_PATH, {
      form: { Email: user.email, Passwd: "wrong-password" },
    });
    expect(res.status()).toBe(401);
    expect(await res.text()).toContain("Error=BadAuthentication");
  });

  test("ClientLogin for an unknown user returns 401", async ({ request }) => {
    const res = await request.post(CLIENT_LOGIN_PATH, {
      form: { Email: "does-not-exist@example.com", Passwd: "whatever" },
    });
    expect(res.status()).toBe(401);
  });
});

test.describe("Google Reader API happy path", () => {
  test("ClientLogin issues a token that authorizes user-info", async ({ request }) => {
    const { user } = await getSeeded();
    const token = await clientLogin(request, user);

    const res = await request.get(`${API_BASE}/user-info`, { headers: authHeader(token) });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.userEmail).toBe(user.email);
    expect(body.userName).toBe(user.email);
  });

  test("token endpoint echoes the auth token", async ({ request }) => {
    const token = await getToken(request);

    const res = await request.get(`${API_BASE}/token`, { headers: authHeader(token) });
    expect(res.status()).toBe(200);
    expect(await res.text()).toBe(token);
  });

  test("subscription/list returns the user's subscribed feed", async ({ request }) => {
    const { feed } = await getSeeded();
    const token = await getToken(request);

    const res = await request.get(`${API_BASE}/subscription/list`, { headers: authHeader(token) });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.subscriptions)).toBe(true);
    const titles = body.subscriptions.map((s: { title: string }) => s.title);
    expect(titles).toContain(feed.title);
  });

  test("stream/items/ids returns item refs for the reading list", async ({ request }) => {
    const token = await getToken(request);

    const res = await request.get(
      `${API_BASE}/stream/items/ids?s=user/-/state/com.google/reading-list`,
      { headers: authHeader(token) }
    );
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.itemRefs)).toBe(true);
    expect(body.itemRefs.length).toBeGreaterThanOrEqual(1);
    for (const ref of body.itemRefs) {
      expect(typeof ref.id).toBe("string");
    }
  });

  test("stream/items/contents returns full items with body for the given ids", async ({
    request,
  }) => {
    const token = await getToken(request);

    // Grab a couple of item ids from the reading list.
    const idsRes = await request.get(
      `${API_BASE}/stream/items/ids?s=user/-/state/com.google/reading-list`,
      { headers: authHeader(token) }
    );
    expect(idsRes.status()).toBe(200);
    const idsBody = await idsRes.json();
    const ids: string[] = idsBody.itemRefs.map((ref: { id: string }) => ref.id);
    expect(ids.length).toBeGreaterThanOrEqual(1);

    // POST them to the batch contents endpoint (form-encoded, i=... repeated).
    const form = new URLSearchParams();
    for (const id of ids) form.append("i", id);
    const res = await request.post(`${API_BASE}/stream/items/contents`, {
      headers: {
        ...authHeader(token),
        "content-type": "application/x-www-form-urlencoded",
      },
      data: form.toString(),
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items.length).toBe(ids.length);
    for (const item of body.items) {
      expect(typeof item.id).toBe("string");
      // formatEntryAsItem always emits the body under `summary.content` — the
      // batch fetch must populate it with the seeded entry's actual content, not
      // an empty string (which is what a failed/missing body fetch produces).
      expect(item.summary.content).toContain("Content for GReader entry");
    }
  });
});

/**
 * A Google Reader token is a *scoped* session (`reader:full-access`), minted so
 * it can't be replayed as a full-access browser session. It must be rejected
 * (as if invalid) by the main tRPC/REST surface — whether presented as a bearer
 * token or as the `session` cookie a browser would send — and by the Wallabag
 * API (which authenticates OAuth access tokens, not sessions). These lock in
 * that a leaked Google Reader token can't reach account management.
 */
test.describe("Google Reader API credential isolation", () => {
  test("token cannot reach account-management endpoints as a bearer token", async ({ request }) => {
    const token = await getToken(request);
    // Session-only account surface (listing the user's active sessions).
    const res = await request.get("/api/v1/users/me/sessions", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status()).toBe(401);
  });

  test("token cannot be replayed as a browser session cookie", async ({ request }) => {
    const token = await getToken(request);
    const res = await request.get("/api/v1/users/me/sessions", {
      headers: { Cookie: `session=${token}` },
    });
    expect(res.status()).toBe(401);
  });

  test("token cannot be replayed against the Wallabag API", async ({ request }) => {
    const token = await getToken(request);
    const res = await request.get("/api/wallabag/api/user", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status()).toBe(401);
  });
});

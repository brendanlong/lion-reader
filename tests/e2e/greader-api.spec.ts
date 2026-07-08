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
  createSavedArticle,
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

  // Newsflash's FreshRSS backend fetches "latest" articles during its initial
  // sync by calling stream/contents with *no* stream id. That must resolve to
  // the reading list, not 404 (which would break account setup). Regression
  // guard for the optional catch-all route ([[...streamId]]).
  test("stream/contents with no stream id returns the reading list", async ({ request }) => {
    const token = await getToken(request);

    const res = await request.post(`${API_BASE}/stream/contents`, { headers: authHeader(token) });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.id).toBe("user/-/state/com.google/reading-list");
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items.length).toBeGreaterThanOrEqual(1);
  });

  test("stream/contents with an explicit stream id still works", async ({ request }) => {
    const token = await getToken(request);

    const res = await request.get(
      `${API_BASE}/stream/contents/user/-/state/com.google/reading-list`,
      { headers: authHeader(token) }
    );
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.id).toBe("user/-/state/com.google/reading-list");
    expect(Array.isArray(body.items)).toBe(true);
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

  // Regression guard: the `continuation` token is our base64 list cursor. It is
  // handed straight back by clients as the `c=` query param, and some (e.g. Read
  // You) concatenate query params WITHOUT URL-encoding. A standard-base64 cursor
  // can contain "+", which then arrives as a space and corrupts the cursor —
  // 400ing every page past the first and aborting the whole sync (0 articles).
  // The token must be URL-safe (base64url: only [A-Za-z0-9_-], no padding) and
  // must round-trip even when sent raw/unescaped.
  test("stream/items/ids continuation is URL-safe and pages when sent unescaped", async ({
    request,
  }) => {
    // Dedicated user so paging with a tiny page size doesn't disturb the shared
    // seeded user's assertions.
    const db = getDb();
    const user = await createPasswordUser(db);
    const feed = await createSubscribedFeed(db, user.id);
    for (let i = 0; i < 3; i++) {
      await createUnreadEntry(db, {
        feedId: feed.feedId,
        userId: user.id,
        title: `Page entry ${i}`,
      });
    }
    const token = await clientLogin(request, user);

    // Page 1 with n=1 forces a continuation across the 3 entries.
    const page1 = await request.get(
      `${API_BASE}/stream/items/ids?s=user/-/state/com.google/reading-list&n=1`,
      { headers: authHeader(token) }
    );
    expect(page1.status()).toBe(200);
    const body1 = await page1.json();
    expect(body1.itemRefs.length).toBe(1);
    const continuation: string = body1.continuation;
    expect(typeof continuation).toBe("string");
    // The crux: URL-safe alphabet only, no "+", "/", or "=".
    expect(continuation).toMatch(/^[A-Za-z0-9_-]+$/);

    // Send the continuation raw (unescaped) the way Read You does. Build the URL
    // by hand so the value isn't re-encoded, mirroring the client's behavior.
    const page2 = await request.get(
      `${API_BASE}/stream/items/ids?s=user/-/state/com.google/reading-list&n=1&c=${continuation}`,
      { headers: authHeader(token) }
    );
    expect(page2.status()).toBe(200);
    const body2 = await page2.json();
    expect(body2.itemRefs.length).toBe(1);
    // Page 2 must be a different item than page 1 (cursor advanced, not reset).
    expect(body2.itemRefs[0].id).not.toBe(body1.itemRefs[0].id);
  });

  // Saved articles (read-it-later) have no subscription row, so they used to
  // surface with an empty origin.streamId and no entry in subscription/list —
  // Google Reader clients dropped them (issue #730). They must now appear as a
  // synthetic uncategorized "Saved Articles" subscription and carry that feed as
  // their origin everywhere.
  test("saved articles are exposed as a synthetic Saved Articles subscription", async ({
    request,
  }) => {
    const db = getDb();
    const user = await createPasswordUser(db);
    const { entry: saved } = await createSavedArticle(db, { userId: user.id, title: "Saved One" });
    const token = await clientLogin(request, user);

    // 1. subscription/list includes an uncategorized "Saved Articles" feed.
    const subsRes = await request.get(`${API_BASE}/subscription/list`, {
      headers: authHeader(token),
    });
    expect(subsRes.status()).toBe(200);
    const subsBody = await subsRes.json();
    const savedSub = subsBody.subscriptions.find(
      (s: { title: string }) => s.title === "Saved Articles"
    );
    expect(savedSub, "Saved Articles subscription present").toBeTruthy();
    expect(savedSub.id).toMatch(/^feed\/\d+$/);
    expect(savedSub.categories).toEqual([]);
    const savedStreamId: string = savedSub.id;

    // 2. The saved article is fetchable via its feed stream, with a real origin.
    const contentsRes = await request.get(`${API_BASE}/stream/contents/${savedStreamId}`, {
      headers: authHeader(token),
    });
    expect(contentsRes.status()).toBe(200);
    const contentsBody = await contentsRes.json();
    const item = contentsBody.items.find((i: { title: string }) => i.title === saved.title);
    expect(item, "saved article returned by its feed stream").toBeTruthy();
    expect(item.origin.streamId).toBe(savedStreamId);
    expect(item.summary.content).toContain("Content for Saved One");

    // 3. The saved article appears in the reading list with the saved feed as its
    //    directStreamIds (not an empty origin).
    const idsRes = await request.get(
      `${API_BASE}/stream/items/ids?s=user/-/state/com.google/reading-list`,
      { headers: authHeader(token) }
    );
    expect(idsRes.status()).toBe(200);
    const idsBody = await idsRes.json();
    const savedRef = idsBody.itemRefs.find((r: { directStreamIds: string[] }) =>
      r.directStreamIds.includes(savedStreamId)
    );
    expect(savedRef, "saved article present in reading list with real origin").toBeTruthy();

    // 4. unread-count counts the saved feed and folds it into the reading-list total.
    const countRes = await request.get(`${API_BASE}/unread-count`, { headers: authHeader(token) });
    expect(countRes.status()).toBe(200);
    const countBody = await countRes.json();
    const savedCount = countBody.unreadcounts.find((c: { id: string }) => c.id === savedStreamId);
    expect(savedCount, "saved feed unread count present").toBeTruthy();
    expect(savedCount.count).toBeGreaterThanOrEqual(1);
    const readingListCount = countBody.unreadcounts.find(
      (c: { id: string }) => c.id === "user/-/state/com.google/reading-list"
    );
    expect(readingListCount.count).toBeGreaterThanOrEqual(1);
  });

  // mark-all-as-read on the synthetic saved feed must actually mark saved
  // articles read (it used to no-op because the saved feed has no subscription).
  test("mark-all-as-read marks the Saved Articles feed read", async ({ request }) => {
    const db = getDb();
    const user = await createPasswordUser(db);
    await createSavedArticle(db, { userId: user.id, title: "Mark Me Read" });
    const token = await clientLogin(request, user);

    // Resolve the synthetic saved feed's stream id from subscription/list.
    const subsBody = await (
      await request.get(`${API_BASE}/subscription/list`, { headers: authHeader(token) })
    ).json();
    const savedStreamId: string = subsBody.subscriptions.find(
      (s: { title: string }) => s.title === "Saved Articles"
    ).id;

    // Precondition: the saved feed has an unread count.
    const before = await (
      await request.get(`${API_BASE}/unread-count`, { headers: authHeader(token) })
    ).json();
    expect(
      before.unreadcounts.find((c: { id: string }) => c.id === savedStreamId)?.count
    ).toBeGreaterThanOrEqual(1);

    // Mark the whole saved feed read.
    const markRes = await request.post(`${API_BASE}/mark-all-as-read`, {
      headers: { ...authHeader(token), "content-type": "application/x-www-form-urlencoded" },
      data: new URLSearchParams({ s: savedStreamId }).toString(),
    });
    expect(markRes.status()).toBe(200);

    // The saved feed no longer appears in unread-count (count dropped to 0).
    const after = await (
      await request.get(`${API_BASE}/unread-count`, { headers: authHeader(token) })
    ).json();
    expect(after.unreadcounts.find((c: { id: string }) => c.id === savedStreamId)).toBeUndefined();
  });

  test("stream/items/contents rejects an oversized id batch with 400", async ({ request }) => {
    const token = await getToken(request);

    // Post more ids than the per-request cap (1000). The values don't need to
    // resolve — the cap is enforced before any lookup.
    const form = new URLSearchParams();
    for (let i = 0; i < 1001; i++) form.append("i", String(i + 1));
    const res = await request.post(`${API_BASE}/stream/items/contents`, {
      headers: {
        ...authHeader(token),
        "content-type": "application/x-www-form-urlencoded",
      },
      data: form.toString(),
    });
    expect(res.status()).toBe(400);
    expect(await res.text()).toContain("Too many item ids");
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

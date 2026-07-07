/**
 * Route-level tests for the Wallabag compatibility API
 * (`src/app/api/wallabag/**`).
 *
 * The Wallabag HTTP surface — OAuth password/refresh grants, bearer-token auth,
 * response formatting, status codes — has no unit/integration coverage (the
 * services it calls do, but the routes themselves don't). This suite exercises
 * the real server over HTTP so regressions in auth handling and status codes
 * are caught.
 *
 * Regression guard for #1018: `requireAuth` used to `throw` a `Response`, which
 * Next.js App Router surfaces as a 500 instead of the intended 401. These tests
 * assert 401 (not 500) for every unauthenticated protected endpoint.
 */

import { createServer, type Server } from "node:http";
import { test, expect, type APIRequestContext } from "@playwright/test";
import { getDb, createPasswordUser, closeTestConnections, type TestPasswordUser } from "./helpers";

const TOKEN_PATH = "/api/wallabag/oauth/v2/token";

/** Protected GET endpoints that must reject unauthenticated requests with 401. */
const PROTECTED_GET_ENDPOINTS = [
  "/api/wallabag/api/user",
  "/api/wallabag/api/entries",
  "/api/wallabag/api/tags",
  "/api/wallabag/api/search",
  "/api/wallabag/api/entries/exists?url=https://example.com",
];

let sharedUser: TestPasswordUser | undefined;

/** A confirmed password user, created once and reused across happy-path tests. */
async function getUser(): Promise<TestPasswordUser> {
  sharedUser ??= await createPasswordUser(getDb());
  return sharedUser;
}

interface TokenPair {
  access_token: string;
  refresh_token: string;
}

let sharedTokens: TokenPair | undefined;

/**
 * Runs the password grant once and memoizes the token pair. The `expensive`
 * per-IP rate-limit bucket (capacity 10, refill 1/s) is shared across both
 * compat login endpoints, so tests must authenticate sparingly rather than
 * logging in on every case.
 */
async function getTokens(request: APIRequestContext): Promise<TokenPair> {
  if (!sharedTokens) {
    const user = await getUser();
    sharedTokens = await passwordGrant(request, user);
  }
  return sharedTokens;
}

/** Runs the password grant and returns the token pair. */
async function passwordGrant(
  request: APIRequestContext,
  user: TestPasswordUser
): Promise<TokenPair> {
  const res = await request.post(TOKEN_PATH, {
    form: {
      grant_type: "password",
      client_id: "wallabag",
      client_secret: "wallabag",
      username: user.email,
      password: user.password,
    },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(typeof body.access_token).toBe("string");
  expect(typeof body.refresh_token).toBe("string");
  expect(body.token_type).toBe("bearer");
  return body;
}

test.afterAll(async () => {
  await closeTestConnections();
});

test.describe("Wallabag API auth", () => {
  test("protected endpoints return 401 (not 500) without a token", async ({ request }) => {
    for (const endpoint of PROTECTED_GET_ENDPOINTS) {
      const res = await request.get(endpoint);
      expect(res.status(), `GET ${endpoint} without auth`).toBe(401);
    }
  });

  test("protected endpoints return 401 with a garbage token", async ({ request }) => {
    for (const endpoint of PROTECTED_GET_ENDPOINTS) {
      const res = await request.get(endpoint, {
        headers: { Authorization: "Bearer not-a-real-token" },
      });
      expect(res.status(), `GET ${endpoint} with garbage token`).toBe(401);
    }
  });

  test("password grant with wrong password returns 401", async ({ request }) => {
    const user = await getUser();
    const res = await request.post(TOKEN_PATH, {
      form: {
        grant_type: "password",
        client_id: "wallabag",
        client_secret: "wallabag",
        username: user.email,
        password: "wrong-password",
      },
    });
    expect(res.status()).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("invalid_grant");
  });

  test("password grant for an unknown user returns 401", async ({ request }) => {
    const res = await request.post(TOKEN_PATH, {
      form: {
        grant_type: "password",
        client_id: "wallabag",
        client_secret: "wallabag",
        username: "does-not-exist@example.com",
        password: "whatever",
      },
    });
    expect(res.status()).toBe(401);
  });

  test("refresh grant with an invalid refresh token returns 401", async ({ request }) => {
    const res = await request.post(TOKEN_PATH, {
      form: {
        grant_type: "refresh_token",
        client_id: "wallabag",
        client_secret: "wallabag",
        refresh_token: "not-a-real-refresh-token",
      },
    });
    expect(res.status()).toBe(401);
  });
});

test.describe("Wallabag API happy path", () => {
  test("password grant issues a working bearer token", async ({ request }) => {
    const user = await getUser();
    const { access_token } = await passwordGrant(request, user);

    const res = await request.get("/api/wallabag/api/user", {
      headers: { Authorization: `Bearer ${access_token}` },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.email).toBe(user.email);
    expect(body.username).toBe(user.email);
  });

  test("list and tags endpoints authorize with a token", async ({ request }) => {
    const { access_token } = await getTokens(request);
    const auth = { Authorization: `Bearer ${access_token}` };

    const listRes = await request.get("/api/wallabag/api/entries", { headers: auth });
    expect(listRes.status()).toBe(200);
    const list = await listRes.json();
    expect(Array.isArray(list._embedded.items)).toBe(true);

    const tagsRes = await request.get("/api/wallabag/api/tags", { headers: auth });
    expect(tagsRes.status()).toBe(200);
    expect(Array.isArray(await tagsRes.json())).toBe(true);
  });

  test("refresh_token grant returns a fresh token pair", async ({ request }) => {
    // A dedicated grant, not the shared token: rotating a refresh token revokes
    // its access token, which would break the other tests that reuse getTokens.
    const user = await getUser();
    const { refresh_token } = await passwordGrant(request, user);

    const res = await request.post(TOKEN_PATH, {
      form: {
        grant_type: "refresh_token",
        client_id: "wallabag",
        client_secret: "wallabag",
        refresh_token,
      },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(typeof body.access_token).toBe("string");
    expect(typeof body.refresh_token).toBe("string");
  });

  test("save an article, see it in the list, then delete it", async ({ request }) => {
    const { access_token } = await getTokens(request);
    const auth = { Authorization: `Bearer ${access_token}` };

    // Serve a tiny article page locally; ALLOW_PRIVATE_NETWORK_FETCH=true in
    // .env.test lets the app fetch localhost, so this exercises the real save
    // pipeline (fetch → clean → persist) end to end.
    const { url, close } = await startArticleServer();
    try {
      const saveRes = await request.post("/api/wallabag/api/entries", {
        headers: auth,
        form: { url },
      });
      expect(saveRes.status()).toBe(200);
      const saved = await saveRes.json();
      expect(typeof saved.id).toBe("number");
      expect(saved.url).toBe(url);

      // The saved article shows up in the entries list.
      const listRes = await request.get("/api/wallabag/api/entries", { headers: auth });
      expect(listRes.status()).toBe(200);
      const list = await listRes.json();
      const ids = list._embedded.items.map((e: { id: number }) => e.id);
      expect(ids).toContain(saved.id);

      // exists reports it as present.
      const existsRes = await request.get(
        `/api/wallabag/api/entries/exists?url=${encodeURIComponent(url)}`,
        { headers: auth }
      );
      expect(existsRes.status()).toBe(200);
      expect((await existsRes.json()).exists).toBe(true);

      // Delete it.
      const deleteRes = await request.delete(`/api/wallabag/api/entries/${saved.id}`, {
        headers: auth,
      });
      expect(deleteRes.status()).toBe(200);

      // Deleting again is a 404 (it's gone).
      const deleteAgain = await request.delete(`/api/wallabag/api/entries/${saved.id}`, {
        headers: auth,
      });
      expect(deleteAgain.status()).toBe(404);
    } finally {
      await close();
    }
  });
});

/**
 * A Wallabag token is an OAuth access token scoped to `reader:full-access`. It
 * must not be usable outside the Wallabag surface: not on the MCP endpoint (that
 * needs the `mcp` scope), not on the main tRPC/REST account-management surface
 * (OAuth tokens aren't accepted there at all), and not on the Google Reader API
 * (which authenticates sessions, not OAuth tokens). These lock in that a leaked
 * Wallabag credential can't be replayed to escalate.
 */
test.describe("Wallabag API credential isolation", () => {
  test("token is rejected at the MCP endpoint (lacks the mcp scope)", async ({ request }) => {
    const { access_token } = await getTokens(request);
    const res = await request.get("/api/mcp", {
      headers: { Authorization: `Bearer ${access_token}` },
    });
    expect(res.status()).toBe(401);
  });

  test("token cannot reach account-management endpoints", async ({ request }) => {
    const { access_token } = await getTokens(request);
    // Session-only account surface (listing the user's active sessions).
    const res = await request.get("/api/v1/users/me/sessions", {
      headers: { Authorization: `Bearer ${access_token}` },
    });
    expect(res.status()).toBe(401);
  });

  test("token cannot be replayed against the Google Reader API", async ({ request }) => {
    const { access_token } = await getTokens(request);
    const res = await request.get("/api/greader.php/reader/api/0/user-info", {
      headers: { Authorization: `Bearer ${access_token}` },
    });
    expect(res.status()).toBe(401);
  });
});

/**
 * Starts a throwaway HTTP server on a random port serving a single article page,
 * returning its URL and a close function. The app fetches this when saving.
 */
async function startArticleServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(
      `<!DOCTYPE html><html><head><title>Wallabag Test Article</title></head>` +
        `<body><article><h1>Wallabag Test Article</h1>` +
        `<p>This is a saved article used by the Wallabag e2e save test. ` +
        `It has enough words for Readability to treat it as real content, ` +
        `so the save pipeline produces a cleaned body.</p></article></body></html>`
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to determine article server port");
  }
  return {
    url: `http://127.0.0.1:${address.port}/article`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

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

      // `since` delta sync is wired through the route: since=0 returns everything,
      // a far-future timestamp returns nothing. (The GREATEST(entry, user_entries)
      // "modified since" semantics are covered in detail by the integration tests.)
      const sinceAll = await request.get("/api/wallabag/api/entries?since=0", { headers: auth });
      expect((await sinceAll.json())._embedded.items.map((e: { id: number }) => e.id)).toContain(
        saved.id
      );
      const sinceFuture = await request.get("/api/wallabag/api/entries?since=9999999999", {
        headers: auth,
      });
      expect((await sinceFuture.json())._embedded.items).toHaveLength(0);

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

  test("saving an unfetchable URL returns a clean 4xx, not a 500", async ({ request }) => {
    const { access_token } = await getTokens(request);
    const auth = { Authorization: `Bearer ${access_token}` };

    // A reachable server that 404s every path — mirrors the real report where a
    // user saved a mistyped URL (a markdown link with a trailing `)`), which the
    // remote returned 404 for. This must surface as a client error, not an
    // unhandled 500 that gets reported to Sentry.
    const { url, close } = await start404Server();
    try {
      const res = await request.post("/api/wallabag/api/entries", {
        headers: auth,
        form: { url },
      });
      // A 404 fetch of a user-provided URL is a client error, not a server bug:
      // exactly 400, not a 500 (which would be reported to Sentry).
      expect(res.status()).toBe(400);
      // Wallabag error envelope, so clients can display why the save failed.
      const body = await res.json();
      expect(body.error).toBe("BAD_REQUEST");
      expect(typeof body.error_description).toBe("string");
    } finally {
      await close();
    }
  });

  test("paginates saved articles with page/perPage (offset)", async ({ request }) => {
    const { access_token } = await getTokens(request);
    const auth = { Authorization: `Bearer ${access_token}` };

    // Two distinct saved articles (two servers → two ports → two URLs).
    const a = await startArticleServer();
    const b = await startArticleServer();
    let idA: number | undefined;
    let idB: number | undefined;
    try {
      idA = (
        await (
          await request.post("/api/wallabag/api/entries", { headers: auth, form: { url: a.url } })
        ).json()
      ).id;
      idB = (
        await (
          await request.post("/api/wallabag/api/entries", { headers: auth, form: { url: b.url } })
        ).json()
      ).id;

      // Ground truth: one big page gives the canonical order and total.
      const allRes = await request.get("/api/wallabag/api/entries?perPage=100&detail=metadata", {
        headers: auth,
      });
      const all = await allRes.json();
      const orderedIds: number[] = all._embedded.items.map((e: { id: number }) => e.id);
      expect(orderedIds).toContain(idA);
      expect(orderedIds).toContain(idB);
      const total: number = all.total;

      // perPage=1 must page through the SAME order via LIMIT/OFFSET, one item per
      // page, with pages == total. This is the regression guard for the old
      // cursor-skip loop (N sequential queries to reach page N).
      const page1 = await (
        await request.get("/api/wallabag/api/entries?perPage=1&page=1&detail=metadata", {
          headers: auth,
        })
      ).json();
      const page2 = await (
        await request.get("/api/wallabag/api/entries?perPage=1&page=2&detail=metadata", {
          headers: auth,
        })
      ).json();

      expect(page1.total).toBe(total);
      expect(page1.pages).toBe(total);
      expect(page1._embedded.items.map((e: { id: number }) => e.id)).toEqual([orderedIds[0]]);
      expect(page2._embedded.items.map((e: { id: number }) => e.id)).toEqual([orderedIds[1]]);

      // A page beyond the data is empty, not an error.
      const beyond = await request.get(
        `/api/wallabag/api/entries?perPage=1&page=${total + 5}&detail=metadata`,
        { headers: auth }
      );
      expect(beyond.status()).toBe(200);
      expect((await beyond.json())._embedded.items).toHaveLength(0);
    } finally {
      if (idA) await request.delete(`/api/wallabag/api/entries/${idA}`, { headers: auth });
      if (idB) await request.delete(`/api/wallabag/api/entries/${idB}`, { headers: auth });
      await a.close();
      await b.close();
    }
  });

  test("tags/domain_name/sort filters are honored, not silently ignored (#1062)", async ({
    request,
  }) => {
    const { access_token } = await getTokens(request);
    const auth = { Authorization: `Bearer ${access_token}` };

    const { url, close } = await startArticleServer();
    const domain = new URL(url).hostname; // 127.0.0.1
    let id: number | undefined;
    try {
      id = (
        await (
          await request.post("/api/wallabag/api/entries", { headers: auth, form: { url } })
        ).json()
      ).id;

      // tags: we don't support tags on saved articles, so any tag filter returns
      // an empty result rather than an unfiltered list.
      const tagged = await request.get("/api/wallabag/api/entries?tags=foo&detail=metadata", {
        headers: auth,
      });
      expect(tagged.status()).toBe(200);
      const taggedBody = await tagged.json();
      expect(taggedBody._embedded.items).toHaveLength(0);
      expect(taggedBody.total).toBe(0);

      // domain_name: the article's host matches; a different host does not.
      const matchDomain = await request.get(
        `/api/wallabag/api/entries?domain_name=${domain}&detail=metadata`,
        { headers: auth }
      );
      expect(matchDomain.status()).toBe(200);
      expect((await matchDomain.json())._embedded.items.map((e: { id: number }) => e.id)).toContain(
        id
      );

      const otherDomain = await request.get(
        "/api/wallabag/api/entries?domain_name=nope.example&detail=metadata",
        { headers: auth }
      );
      expect(
        (await otherDomain.json())._embedded.items.map((e: { id: number }) => e.id)
      ).not.toContain(id);

      // sort=updated and sort=archived are accepted (not 500) and still return
      // the article.
      for (const sort of ["updated", "archived", "created"]) {
        const sorted = await request.get(
          `/api/wallabag/api/entries?sort=${sort}&detail=metadata&perPage=100`,
          { headers: auth }
        );
        expect(sorted.status(), `sort=${sort}`).toBe(200);
        expect(
          (await sorted.json())._embedded.items.map((e: { id: number }) => e.id),
          `sort=${sort}`
        ).toContain(id);
      }
    } finally {
      if (id) await request.delete(`/api/wallabag/api/entries/${id}`, { headers: auth });
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

/**
 * A reachable server that returns 404 for every request, used to exercise the
 * "save a URL that can't be fetched" error path.
 */
async function start404Server(): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((_req, res) => {
    res.writeHead(404, { "Content-Type": "text/html" });
    res.end("<!DOCTYPE html><html><body>Not Found</body></html>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to determine 404 server port");
  }
  return {
    url: `http://127.0.0.1:${address.port}/missing`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

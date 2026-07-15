/**
 * Integration tests for feed detection on the save path.
 *
 * When a user shares/saves a URL that is actually a feed (not an article), the
 * PWA should route them to Subscribe instead of saving garbage. The server
 * signals this by throwing the machine-readable `URL_IS_FEED` error from
 * `saveArticle` (see `src/server/services/saved.ts`), which the /save page turns
 * into a redirect to `/subscribe?url=...`.
 *
 * These drive real HTTP requests against a loopback server so the actual fetch +
 * content-type handling is covered (`.env.test` sets ALLOW_PRIVATE_NETWORK_FETCH).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { type AddressInfo } from "node:net";
import { TRPCError } from "@trpc/server";
import { db } from "../../src/server/db";
import { users } from "../../src/server/db/schema";
import { generateUuidv7 } from "../../src/lib/uuidv7";
import { saveArticle } from "../../src/server/services/saved";
import { getAppErrorCode } from "../../src/server/trpc/errors";

const RSS_BODY = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Example Feed</title>
<item><title>First post</title></item></channel></rss>`;

// Non-feed XML (a sitemap) served with an ambiguous content type — must NOT be
// treated as a feed even though the content type alone doesn't rule it out.
const SITEMAP_BODY = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<url><loc>https://example.com/</loc></url></urlset>`;

const HTML_BODY = `<!doctype html><html><head><title>An Article</title></head>
<body><article><h1>An Article</h1><p>${"Some real body text. ".repeat(40)}</p></article></body></html>`;

// A valid JSON Feed vs. a plain JSON API response, both served as
// application/json (the ambiguous branch): the feed must route to Subscribe, the
// API must not.
const JSON_FEED_BODY = JSON.stringify({
  version: "https://jsonfeed.org/version/1.1",
  title: "Example JSON Feed",
  items: [{ id: "1", title: "First post" }],
});
const JSON_API_BODY = JSON.stringify({ data: [1, 2, 3], ok: true });

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = req.url ?? "/";
    if (path === "/feed.xml") {
      // Unambiguous feed content type — routed to Subscribe without a 2nd fetch.
      res.writeHead(200, { "Content-Type": "application/rss+xml; charset=utf-8" });
      res.end(RSS_BODY);
    } else if (path === "/ambiguous-feed") {
      // Ambiguous content type but the body sniffs as a feed → still Subscribe.
      res.writeHead(200, { "Content-Type": "application/xml" });
      res.end(RSS_BODY);
    } else if (path === "/sitemap.xml") {
      // Ambiguous content type, non-feed body → normal save-fetch error, not a feed.
      res.writeHead(200, { "Content-Type": "application/xml" });
      res.end(SITEMAP_BODY);
    } else if (path === "/json-feed") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON_FEED_BODY);
    } else if (path === "/json-api") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON_API_BODY);
    } else if (path === "/article") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(HTML_BODY);
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function createTestUser(): Promise<string> {
  const userId = generateUuidv7();
  await db.insert(users).values({
    id: userId,
    email: `feed-detect-${userId}@test.com`,
    passwordHash: "test-hash",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return userId;
}

describe("saveArticle feed detection", () => {
  it("throws URL_IS_FEED for a URL served as a feed content type", async () => {
    const userId = await createTestUser();
    const promise = saveArticle(db, userId, { url: `${baseUrl}/feed.xml` });
    await expect(promise).rejects.toBeInstanceOf(TRPCError);
    await promise.catch((error) => {
      expect(error.message).toBe("URL_IS_FEED");
      expect(getAppErrorCode(error)).toBe("URL_IS_FEED");
    });
  });

  it("throws URL_IS_FEED for an ambiguous content type whose body is a feed", async () => {
    const userId = await createTestUser();
    await expect(saveArticle(db, userId, { url: `${baseUrl}/ambiguous-feed` })).rejects.toThrow(
      "URL_IS_FEED"
    );
  });

  it("does not treat a non-feed XML document (sitemap) as a feed", async () => {
    const userId = await createTestUser();
    const promise = saveArticle(db, userId, { url: `${baseUrl}/sitemap.xml` });
    // Not a feed → the original fetch failure surfaces, not URL_IS_FEED.
    await expect(promise).rejects.toThrow();
    await promise.catch((error) => {
      expect(error.message).not.toBe("URL_IS_FEED");
      expect(getAppErrorCode(error)).toBe("SAVED_ARTICLE_FETCH_ERROR");
    });
  });

  it("throws URL_IS_FEED for a valid JSON Feed served as application/json", async () => {
    const userId = await createTestUser();
    await expect(saveArticle(db, userId, { url: `${baseUrl}/json-feed` })).rejects.toThrow(
      "URL_IS_FEED"
    );
  });

  it("does not treat a plain JSON API response as a feed", async () => {
    const userId = await createTestUser();
    const promise = saveArticle(db, userId, { url: `${baseUrl}/json-api` });
    await expect(promise).rejects.toThrow();
    await promise.catch((error) => {
      expect(error.message).not.toBe("URL_IS_FEED");
      expect(getAppErrorCode(error)).toBe("SAVED_ARTICLE_FETCH_ERROR");
    });
  });

  it("saves a normal HTML article without triggering feed detection", async () => {
    const userId = await createTestUser();
    const result = await saveArticle(db, userId, { url: `${baseUrl}/article` });
    expect(result.outcome).toBe("created");
    expect(result.title).toBe("An Article");
  });
});

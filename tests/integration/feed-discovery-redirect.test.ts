/**
 * Integration tests for `feeds.discover` against a redirecting page.
 *
 * A blog URL that redirects (http → https, apex → subdomain, a moved path) is
 * the common case, and `<link rel="alternate" href="feed.xml">` is relative to
 * the page it was served from. Resolving it against the requested URL instead of
 * the post-redirect one yields a feed URL on the wrong host/path, and the user
 * subscribes to a 404 — so this drives real HTTP redirects against loopback
 * servers (`.env.test` sets ALLOW_PRIVATE_NETWORK_FETCH).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { type AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import { db } from "../../src/server/db";
import { users } from "../../src/server/db/schema";
import { createCaller } from "../../src/server/trpc/root";
import { createAuthContext, createTestUser } from "./helpers";

const PAGE_HTML = (href: string) =>
  `<!doctype html><html><head><title>A Blog</title>
<link rel="alternate" type="application/rss+xml" title="A Blog Feed" href="${href}">
</head><body><h1>A Blog</h1></body></html>`;

/** The page the request is redirected to; serves the relative feed link. */
let targetServer: Server;
let targetBaseUrl: string;
/** The URL the user types; redirects to the other origin. */
let originServer: Server;
let originBaseUrl: string;

const createdUserIds: string[] = [];

async function createUser(): Promise<string> {
  const userId = await createTestUser({ emailPrefix: "discover-redirect" });
  createdUserIds.push(userId);
  return userId;
}

beforeAll(async () => {
  targetServer = createServer((req, res) => {
    const path = req.url ?? "/";
    if (path === "/writing/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(PAGE_HTML("feed.xml"));
    } else {
      // Everything else (including the feed itself and the common-path probes)
      // 404s: discovery must report the link it found, not fetch it.
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve) => targetServer.listen(0, "127.0.0.1", resolve));
  targetBaseUrl = `http://127.0.0.1:${(targetServer.address() as AddressInfo).port}`;

  originServer = createServer((req, res) => {
    if ((req.url ?? "/") === "/blog") {
      res.writeHead(301, { Location: `${targetBaseUrl}/writing/` });
      res.end();
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve) => originServer.listen(0, "127.0.0.1", resolve));
  originBaseUrl = `http://127.0.0.1:${(originServer.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => originServer.close(() => resolve()));
  await new Promise<void>((resolve) => targetServer.close(() => resolve()));
  for (const id of createdUserIds) {
    await db.delete(users).where(eq(users.id, id));
  }
});

describe("feeds.discover", () => {
  it("resolves relative feed links against the post-redirect URL", async () => {
    const userId = await createUser();
    const caller = createCaller(await createAuthContext(userId));

    const { feeds } = await caller.feeds.discover({ url: `${originBaseUrl}/blog` });

    // `feed.xml` is relative to the page that was actually served, so it lives
    // on the redirect target's host and directory — not the requested origin.
    expect(feeds.map((f) => f.url)).toEqual([`${targetBaseUrl}/writing/feed.xml`]);
  });
});

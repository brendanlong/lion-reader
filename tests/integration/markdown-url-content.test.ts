/**
 * Integration tests for URLs that serve Markdown instead of HTML.
 *
 * We ask for HTML (#1280), but a raw `.md` URL answers with `text/markdown`
 * anyway. Both entry points that fetch article content — `fetchFullContent`
 * (the per-subscription "fetch full content" path) and `saveArticle` (read it
 * later) — render that Markdown and skip Readability, which is the pass that
 * absolutizes relative URLs everywhere else. Neither the Markdown renderer nor
 * the sanitizer resolves relative URLs, so these tests pin that the stored
 * content resolves them against the source URL rather than leaving `img/x.png`
 * to resolve against Lion Reader's own origin in the browser.
 *
 * These drive real HTTP requests against a loopback server so the content-type
 * detection and redirect handling are covered too (`.env.test` sets
 * ALLOW_PRIVATE_NETWORK_FETCH).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { type AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import { db } from "../../src/server/db";
import { entries, users } from "../../src/server/db/schema";
import { fetchFullContent } from "../../src/server/services/full-content";
import { saveArticle } from "../../src/server/services/saved";
import { createTestUser } from "./helpers";

const MARKDOWN_BODY = [
  "# Deep Dive",
  "",
  "An opening paragraph with enough prose that every length threshold in the",
  "pipeline is comfortably cleared and the body is treated as real content.",
  "",
  "![A figure](img/fig.png)",
  "",
  "See the [companion post](other/post.md) and the [index](/index.md).",
  "",
  "A closing paragraph so the document is unambiguously article-sized.",
].join("\n");

let server: Server;
let baseUrl: string;

const createdUserIds: string[] = [];

async function createUser(): Promise<string> {
  const userId = await createTestUser({ emailPrefix: "md-url" });
  createdUserIds.push(userId);
  return userId;
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = req.url ?? "/";
    if (path === "/docs/post.md") {
      res.writeHead(200, { "Content-Type": "text/markdown; charset=utf-8" });
      res.end(MARKDOWN_BODY);
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
  for (const id of createdUserIds) {
    await db.delete(users).where(eq(users.id, id));
  }
});

describe("fetchFullContent on a Markdown URL", () => {
  it("absolutizes relative URLs in the content that gets displayed", async () => {
    const result = await fetchFullContent(`${baseUrl}/docs/post.md`);

    expect(result.success).toBe(true);
    // `selectDisplayedContent` prefers the cleaned variant, so that is the one
    // that must carry absolute URLs.
    expect(result.contentCleaned).toContain(`${baseUrl}/docs/img/fig.png`);
    expect(result.contentCleaned).toContain(`${baseUrl}/docs/other/post.md`);
    expect(result.contentCleaned).toContain(`${baseUrl}/index.md`);
    expect(result.contentCleaned).not.toContain('src="img/fig.png"');
    expect(result.contentCleaned).not.toContain('href="other/post.md"');
  });

  it("stores the same absolutized content as the original variant", async () => {
    const result = await fetchFullContent(`${baseUrl}/docs/post.md`);

    // Markdown has no "original" HTML distinct from the rendered output, so both
    // stored variants are the same absolutized string — "show original" must not
    // fall back to relative URLs.
    expect(result.contentOriginal).toBe(result.contentCleaned);
  });

  it("runs identically with the background worker's inline cleaning", async () => {
    const result = await fetchFullContent(`${baseUrl}/docs/post.md`, { offloadClean: false });

    expect(result.success).toBe(true);
    expect(result.contentCleaned).toContain(`${baseUrl}/docs/img/fig.png`);
  });
});

describe("saveArticle on a Markdown URL", () => {
  it("absolutizes relative URLs in the stored cleaned content", async () => {
    const userId = await createUser();
    const article = await saveArticle(db, userId, { url: `${baseUrl}/docs/post.md` });

    const [stored] = await db
      .select({ contentCleaned: entries.contentCleaned })
      .from(entries)
      .where(eq(entries.id, article.id))
      .limit(1);

    // Readability is skipped for Markdown (it is already clean), so the
    // absolutize pass has to happen on the pre-cleaned HTML itself.
    expect(stored.contentCleaned).toContain(`${baseUrl}/docs/img/fig.png`);
    expect(stored.contentCleaned).toContain(`${baseUrl}/docs/other/post.md`);
    expect(stored.contentCleaned).toContain(`${baseUrl}/index.md`);
    expect(stored.contentCleaned).not.toContain('src="img/fig.png"');
  });
});

/**
 * Integration tests for `acquireArticleContent`, the one article-fetch path
 * behind saves and full-content fetches: plugin precedence and fallback, and
 * when a fetched page is offered to `fetchContentFromPage` plugins.
 *
 * Fixture plugins claim the loopback host, and the generic fetch hits a real
 * loopback server (`.env.test` sets ALLOW_PRIVATE_NETWORK_FETCH).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { type AddressInfo } from "node:net";
import { acquireArticleContent, pluginRegistry, UserFetchError } from "../../src/server/plugins";
import { HttpFetchError } from "../../src/server/http/fetch";
import { usageLimitsConfig } from "../../src/server/config/env";

const PAGE_HTML = "<html><head><title>Page</title></head><body><p>Page body</p></body></html>";
const CLAIM_MARKER = '<meta name="fixture-claim">';
const HUGE_CLAIM_MARKER = '<meta name="fixture-claim-huge">';
const tooLarge = () => "x".repeat(usageLimitsConfig.maxSavedArticleSizeBytes + 1);

let server: Server;
let baseUrl: string;
let pageRequests: string[] = [];

pluginRegistry.register({
  name: "fixture-hostname",
  hosts: ["127.0.0.1"],
  matchUrl: (url) => url.pathname.startsWith("/plugin/"),
  capabilities: {
    savedArticle: {
      async fetchContent(url) {
        switch (url.pathname) {
          case "/plugin/ok":
            return { html: "<p>From plugin</p>" };
          case "/plugin/rate-limited":
            throw new HttpFetchError(429, "Too Many Requests", url.href);
          case "/plugin/broken":
            throw new Error("plugin bug");
          default:
            return null;
        }
      },
      async fetchContentAsUser(url, user) {
        switch (url.pathname) {
          case "/plugin/as-user":
            return { html: `<p>For ${user.userId}</p>` };
          case "/plugin/as-user-broken":
            throw new Error("needs consent");
          default:
            return null;
        }
      },
      skipReadability: true,
      siteName: "Fixture",
    },
  },
});

pluginRegistry.register({
  name: "fixture-page-claim",
  hosts: ["fixture-page-claim.invalid"],
  matchUrl: () => true,
  capabilities: {
    savedArticle: {
      fetchContent: async () => null,
      async fetchContentFromPage(page) {
        if (page.html.includes(HUGE_CLAIM_MARKER)) return { html: tooLarge() };
        if (page.html.includes(CLAIM_MARKER)) return { html: "<p>Claimed</p>" };
        return null;
      },
    },
  },
});

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = req.url ?? "/";
    pageRequests.push(path);
    if (path === "/page/claimable" || path === "/plugin/claimable") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<html><head>${CLAIM_MARKER}</head><body>Page</body></html>`);
    } else if (path === "/page/claimable-huge") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<html><head>${HUGE_CLAIM_MARKER}</head><body>Page</body></html>`);
    } else if (path === "/page/markdown") {
      res.writeHead(200, { "Content-Type": "text/markdown" });
      res.end(`# Title\n\n${CLAIM_MARKER}`);
    } else {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(PAGE_HTML);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  pageRequests = [];
});

describe("acquireArticleContent: hostname plugin", () => {
  it("returns the plugin's content without fetching the page", async () => {
    const url = `${baseUrl}/plugin/ok`;
    const acquired = await acquireArticleContent(url);
    expect(acquired).toMatchObject({
      kind: "plugin",
      source: "fixture-hostname",
      content: { html: "<p>From plugin</p>" },
      skipReadability: true,
      siteName: "Fixture",
      baseUrl: url,
    });
    expect(pageRequests).toEqual([]);
  });

  it("rethrows a plugin rate limit instead of fetching the same host", async () => {
    await expect(acquireArticleContent(`${baseUrl}/plugin/rate-limited`)).rejects.toThrow(
      HttpFetchError
    );
    expect(pageRequests).toEqual([]);
  });

  it("falls back to the page when the plugin fails", async () => {
    const acquired = await acquireArticleContent(`${baseUrl}/plugin/broken`);
    expect(acquired).toMatchObject({ kind: "page", content: PAGE_HTML });
  });

  it("does not offer a hostname-matched page to fetched-page plugins", async () => {
    const acquired = await acquireArticleContent(`${baseUrl}/plugin/claimable`);
    expect(acquired.kind).toBe("page");
  });
});

describe("acquireArticleContent: fetchContentAsUser", () => {
  const asUser = { userId: "user-1", authMode: "interactive" } as const;

  it("fetches as the user after fetchContent declines, without fetching the page", async () => {
    const url = `${baseUrl}/plugin/as-user`;
    const acquired = await acquireArticleContent(url, { asUser });
    expect(acquired).toMatchObject({
      kind: "plugin",
      source: "fixture-hostname",
      content: { html: "<p>For user-1</p>" },
      baseUrl: url,
    });
    expect(pageRequests).toEqual([]);
  });

  it("is not tried without a user", async () => {
    const acquired = await acquireArticleContent(`${baseUrl}/plugin/as-user`);
    expect(acquired).toMatchObject({ kind: "page", content: PAGE_HTML });
  });

  it("throws its failure as a UserFetchError instead of fetching the page", async () => {
    const failure = acquireArticleContent(`${baseUrl}/plugin/as-user-broken`, { asUser });
    await expect(failure).rejects.toBeInstanceOf(UserFetchError);
    await expect(failure).rejects.toMatchObject({ cause: { message: "needs consent" } });
    expect(pageRequests).toEqual([]);
  });
});

describe("acquireArticleContent: fetched-page plugins", () => {
  it("lets a plugin claim a page no hostname plugin matched", async () => {
    const url = `${baseUrl}/page/claimable`;
    const acquired = await acquireArticleContent(url);
    expect(acquired).toMatchObject({
      kind: "plugin",
      source: "fixture-page-claim",
      content: { html: "<p>Claimed</p>" },
      baseUrl: url,
    });
  });

  it("keeps the page when the claimed content is over the size cap", async () => {
    const acquired = await acquireArticleContent(`${baseUrl}/page/claimable-huge`);
    expect(acquired.kind).toBe("page");
  });

  it("does not offer Markdown to fetched-page plugins", async () => {
    const acquired = await acquireArticleContent(`${baseUrl}/page/markdown`);
    expect(acquired).toMatchObject({ kind: "page", isMarkdown: true });
  });
});

/**
 * Integration tests for `fetchPluginPage`, the shared page fetch behind the
 * scrape-only plugins (LinkedIn, Threads).
 *
 * The interesting behavior is error *classification*, which decides whether a
 * failed fetch falls back to normal handling or fails the save. Getting it
 * wrong is invisible in a unit test and expensive in production — falling back
 * on a 429 re-requests the host that just throttled us, which is exactly what
 * `acquireArticleContent`'s rate-limit branch exists to prevent.
 *
 * These drive real HTTP requests against a loopback server so the real fetch +
 * error path is covered (`.env.test` sets ALLOW_PRIVATE_NETWORK_FETCH).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { type AddressInfo } from "node:net";
import { fetchPluginPage } from "../../src/server/plugins/fetch-page";
import { HttpFetchError } from "../../src/server/http/fetch";

const HTML_BODY = "<!doctype html><html><head><title>A Post</title></head><body>hi</body></html>";

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = req.url ?? "/";
    if (path === "/ok") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(HTML_BODY);
    } else if (path === "/redirect") {
      res.writeHead(302, { Location: "/ok" });
      res.end();
    } else if (path === "/markdown") {
      res.writeHead(200, { "Content-Type": "text/markdown" });
      res.end("# Not HTML");
    } else if (path === "/rate-limited") {
      res.writeHead(429, { "Content-Type": "text/html" });
      res.end("slow down");
    } else if (path === "/blocked") {
      res.writeHead(403, { "Content-Type": "text/html" });
      res.end("nope");
    } else if (path === "/linkedin-999") {
      // LinkedIn's nonstandard status for datacenter IP ranges.
      res.writeHead(999, { "Content-Type": "text/html" });
      res.end("request denied");
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

describe("fetchPluginPage", () => {
  it("returns the HTML and the post-redirect URL", async () => {
    const page = await fetchPluginPage(new URL(`${baseUrl}/ok`), "test");
    expect(page?.html).toBe(HTML_BODY);
    expect(page?.finalUrl).toBe(`${baseUrl}/ok`);
  });

  it("reports the final URL after a redirect, not the requested one", async () => {
    const page = await fetchPluginPage(new URL(`${baseUrl}/redirect`), "test");
    expect(page?.finalUrl).toBe(`${baseUrl}/ok`);
  });

  it("rethrows a rate limit so the save reports it instead of refetching the same host", async () => {
    await expect(fetchPluginPage(new URL(`${baseUrl}/rate-limited`), "test")).rejects.toThrow(
      HttpFetchError
    );
  });

  it.each([
    ["a block", "/blocked"],
    ["LinkedIn's 999", "/linkedin-999"],
    ["a missing post", "/nope"],
    ["a non-HTML response", "/markdown"],
  ])("returns null for %s, so the save falls back", async (_label, path) => {
    expect(await fetchPluginPage(new URL(`${baseUrl}${path}`), "test")).toBeNull();
  });

  it("returns null when the host is unreachable", async () => {
    expect(await fetchPluginPage(new URL("http://127.0.0.1:1/unreachable"), "test")).toBeNull();
  });
});

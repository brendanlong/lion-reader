/**
 * Unit tests for the Next.js proxy (middleware).
 *
 * The proxy has two jobs, both claude.ai OAuth/MCP workarounds: the
 * POST/OPTIONS `/register` method-split to the DCR handler at `/oauth/register`,
 * and trailing-slash normalization (rewrite the OAuth/MCP surface in place,
 * 308 everything else — `skipTrailingSlashRedirect` disables Next's built-in
 * redirect). Route authentication is deliberately NOT handled here — it lives
 * in the server-side layout guards (see issue #984).
 */

import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "../../src/proxy";

function makeRequest(path: string, method = "GET"): NextRequest {
  return new NextRequest(new URL(`https://reader.example.com${path}`), { method });
}

describe("proxy", () => {
  it.each(["POST", "OPTIONS"])(
    "rewrites %s /register to the OAuth DCR handler at /oauth/register",
    (method) => {
      const res = proxy(makeRequest("/register", method));
      const rewrite = new URL(res.headers.get("x-middleware-rewrite")!);
      expect(rewrite.pathname).toBe("/oauth/register");
      // A rewrite is not a redirect — the URL stays /register for the client.
      expect(res.headers.get("location")).toBeNull();
    }
  );

  it("does not rewrite GET /register (the human signup page)", () => {
    const res = proxy(makeRequest("/register"));
    expect(res.headers.get("x-middleware-rewrite")).toBeNull();
    expect(res.headers.get("location")).toBeNull();
  });

  it("does not gate auth: an unauthenticated protected path passes through untouched", () => {
    // Auth is handled by the server-side layout guards, not the proxy (#984).
    const res = proxy(makeRequest("/all"));
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("x-middleware-rewrite")).toBeNull();
  });

  it("only rewrites the exact /register path, not method-matching other paths", () => {
    // Defensive: the pathname guard keeps the rewrite scoped even if the
    // matcher is ever widened.
    const res = proxy(makeRequest("/register-something", "POST"));
    expect(res.headers.get("x-middleware-rewrite")).toBeNull();
  });
});

describe("proxy trailing-slash handling (skipTrailingSlashRedirect)", () => {
  // Server-to-server OAuth/MCP clients (claude.ai uses python-httpx) don't
  // follow redirects on POST, and claude.ai has been observed appending
  // trailing slashes (anthropics/claude-ai-mcp#324) — so the OAuth/MCP surface
  // must answer slashed URLs in place, like Linear/Sentry/Notion do.
  it.each([
    ["/api/mcp/", "/api/mcp", "POST"],
    ["/oauth/token/", "/oauth/token", "POST"],
    ["/oauth/authorize/", "/oauth/authorize", "GET"],
    ["/oauth/register/", "/oauth/register", "POST"],
    ["/oauth/revoke/", "/oauth/revoke", "POST"],
    ["/token/", "/token", "POST"],
    ["/authorize/", "/authorize", "GET"],
    [
      "/.well-known/oauth-protected-resource/api/mcp/",
      "/.well-known/oauth-protected-resource/api/mcp",
      "GET",
    ],
    ["/.well-known/oauth-authorization-server/", "/.well-known/oauth-authorization-server", "GET"],
  ])("rewrites %s in place (no redirect)", (slashed, expected, method) => {
    const res = proxy(makeRequest(slashed, method));
    const rewrite = new URL(res.headers.get("x-middleware-rewrite")!);
    expect(rewrite.pathname).toBe(expected);
    expect(res.headers.get("location")).toBeNull();
  });

  it("routes POST /register/ all the way to the DCR handler", () => {
    const res = proxy(makeRequest("/register/", "POST"));
    const rewrite = new URL(res.headers.get("x-middleware-rewrite")!);
    expect(rewrite.pathname).toBe("/oauth/register");
  });

  it("308-redirects GET /register/ (the human signup page keeps Next's default)", () => {
    const res = proxy(makeRequest("/register/"));
    expect(res.status).toBe(308);
    expect(new URL(res.headers.get("location")!).pathname).toBe("/register");
  });

  it("308-redirects other slashed paths, preserving the query string", () => {
    const res = proxy(makeRequest("/all/?foo=bar"));
    expect(res.status).toBe(308);
    const location = new URL(res.headers.get("location")!);
    expect(location.pathname).toBe("/all");
    expect(location.search).toBe("?foo=bar");
  });

  it("collapses repeated trailing slashes in one hop", () => {
    const res = proxy(makeRequest("/api/mcp///", "POST"));
    const rewrite = new URL(res.headers.get("x-middleware-rewrite")!);
    expect(rewrite.pathname).toBe("/api/mcp");
  });

  it("leaves the root path alone", () => {
    const res = proxy(makeRequest("/"));
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("x-middleware-rewrite")).toBeNull();
  });
});

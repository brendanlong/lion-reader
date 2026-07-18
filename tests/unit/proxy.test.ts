/**
 * Unit tests for the Next.js proxy (middleware).
 *
 * The proxy's only job is the claude.ai OAuth workaround: rewriting POST/OPTIONS
 * `/register` to the Dynamic Client Registration handler at `/oauth/register`.
 * Route authentication is deliberately NOT handled here — it lives in the
 * server-side layout guards (see issue #984). These tests pin down the rewrite
 * behavior and that nothing else is redirected/rewritten.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "../../src/proxy";

function makeRequest(path: string, method = "GET", headers?: Record<string, string>): NextRequest {
  // Real requests always carry a Host header; NextRequest doesn't derive one from
  // the URL, so set it explicitly to match the origin.
  return new NextRequest(new URL(`https://reader.example.com${path}`), {
    method,
    headers: { host: "reader.example.com", ...headers },
  });
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

describe("proxy request logging (LOG_MCP_REQUESTS)", () => {
  const originalMcpHost = process.env.MCP_HOST;

  afterEach(() => {
    delete process.env.LOG_MCP_REQUESTS;
    if (originalMcpHost === undefined) {
      delete process.env.MCP_HOST;
    } else {
      process.env.MCP_HOST = originalMcpHost;
    }
    vi.restoreAllMocks();
  });

  it("logs nothing when LOG_MCP_REQUESTS is unset", () => {
    delete process.env.LOG_MCP_REQUESTS;
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    proxy(makeRequest("/mcp", "POST"));
    expect(spy).not.toHaveBeenCalled();
  });

  it("logs a structured line with host/method/path and hasAuthorization boolean", () => {
    process.env.LOG_MCP_REQUESTS = "true";
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    proxy(makeRequest("/mcp", "POST", { authorization: "Bearer super-secret-token" }));
    expect(spy).toHaveBeenCalledOnce();
    const entry = JSON.parse(spy.mock.calls[0][0] as string);
    expect(entry).toMatchObject({
      message: "MCP debug request",
      host: "reader.example.com",
      method: "POST",
      path: "/mcp",
      hasAuthorization: true,
    });
    // The token value must never appear anywhere in the log line.
    expect(spy.mock.calls[0][0]).not.toContain("super-secret-token");
  });

  it("reports hasAuthorization=false when no Authorization header is present", () => {
    process.env.LOG_MCP_REQUESTS = "true";
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    proxy(makeRequest("/mcp", "POST"));
    const entry = JSON.parse(spy.mock.calls[0][0] as string);
    expect(entry.hasAuthorization).toBe(false);
  });

  it("does NOT log ordinary (non-surface) apex traffic even when enabled", () => {
    // No MCP host configured, so only the OAuth/MCP surface is logged on the apex.
    process.env.LOG_MCP_REQUESTS = "true";
    delete process.env.MCP_HOST;
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    proxy(makeRequest("/all"));
    proxy(makeRequest("/api/trpc/entries.list"));
    expect(spy).not.toHaveBeenCalled();
  });

  it("logs EVERY path on the dedicated MCP host, including unexpected ones", () => {
    // The point: catch a request to a path we didn't anticipate (the "wrong URL"
    // / origin-root-fallback failure modes) so it doesn't slip through unlogged.
    process.env.LOG_MCP_REQUESTS = "true";
    process.env.MCP_HOST = "mcp.example.com";
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    proxy(makeRequest("/some/unexpected/path", "GET", { host: "MCP.example.com:443" }));
    expect(spy).toHaveBeenCalledOnce();
    const entry = JSON.parse(spy.mock.calls[0][0] as string);
    expect(entry.path).toBe("/some/unexpected/path");
  });

  it("does not log unexpected paths on a host that isn't the MCP host", () => {
    process.env.LOG_MCP_REQUESTS = "true";
    process.env.MCP_HOST = "mcp.example.com";
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    proxy(makeRequest("/some/unexpected/path", "GET", { host: "reader.example.com" }));
    expect(spy).not.toHaveBeenCalled();
  });

  it("redacts sensitive query params (auth code) but keeps public ones", () => {
    process.env.LOG_MCP_REQUESTS = "true";
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    proxy(makeRequest("/oauth/authorize?client_id=abc&code=SECRET_CODE&state=xyz", "GET"));
    const entry = JSON.parse(spy.mock.calls[0][0] as string);
    const query = new URLSearchParams(entry.query);
    expect(query.get("client_id")).toBe("abc");
    expect(query.get("state")).toBe("xyz");
    expect(query.get("code")).toBe("[redacted]");
    expect(spy.mock.calls[0][0]).not.toContain("SECRET_CODE");
  });

  it("still performs the /register rewrite while logging is enabled", () => {
    process.env.LOG_MCP_REQUESTS = "true";
    vi.spyOn(console, "log").mockImplementation(() => {});
    const res = proxy(makeRequest("/register", "POST"));
    const rewrite = new URL(res.headers.get("x-middleware-rewrite")!);
    expect(rewrite.pathname).toBe("/oauth/register");
  });
});

describe("proxy CSP tiering (issue #1359)", () => {
  const PUBLIC_PATHS = [
    "/demo",
    "/demo/all",
    "/demo/entry/welcome",
    "/login",
    "/terms",
    "/privacy",
  ];
  const DYNAMIC_PATHS = [
    "/",
    "/all",
    "/auth/oauth/complete",
    "/settings",
    "/api/trpc/entries.list",
  ];

  it.each(PUBLIC_PATHS)("%s gets the relaxed static CSP with no nonce", (path) => {
    const res = proxy(makeRequest(path));
    const csp = res.headers.get("Content-Security-Policy")!;
    expect(csp).toMatch(/script-src[^;]*'unsafe-inline'/);
    expect(csp).not.toContain("'nonce-");
    // 'strict-dynamic' would make browsers ignore 'unsafe-inline' and the
    // 'self' allowlist, blocking every script on the static pages.
    expect(csp).not.toContain("'strict-dynamic'");
    // No per-request header rewriting: the response must not carry the
    // middleware override markers that a modified request would produce.
    expect(res.headers.get("x-middleware-override-headers")).toBeNull();
  });

  it.each(DYNAMIC_PATHS)("%s gets the strict nonce'd CSP", (path) => {
    const res = proxy(makeRequest(path));
    const csp = res.headers.get("Content-Security-Policy")!;
    expect(csp).toMatch(/script-src[^;]*'nonce-[A-Za-z0-9+/=_-]+'/);
    expect(csp).toContain("'strict-dynamic'");
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
  });

  it("GET /register (the signup page) gets the relaxed static CSP", () => {
    const res = proxy(makeRequest("/register"));
    expect(res.headers.get("Content-Security-Policy")).toMatch(/script-src[^;]*'unsafe-inline'/);
    expect(res.headers.get("x-middleware-rewrite")).toBeNull();
  });

  it.each(["POST", "OPTIONS"])(
    "%s /register (the OAuth DCR rewrite) keeps the strict nonce'd CSP",
    (method) => {
      const res = proxy(makeRequest("/register", method));
      expect(new URL(res.headers.get("x-middleware-rewrite")!).pathname).toBe("/oauth/register");
      expect(res.headers.get("Content-Security-Policy")).toContain("'nonce-");
    }
  );

  it("does not treat demo-prefixed lookalike paths as public", () => {
    const res = proxy(makeRequest("/demonstration"));
    expect(res.headers.get("Content-Security-Policy")).toContain("'nonce-");
  });
});

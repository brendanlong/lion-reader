/**
 * Unit tests for the Next.js proxy (middleware).
 *
 * The proxy handles session redirects, CSP tiering, and optional OAuth/MCP
 * request logging. Route authentication is deliberately NOT handled here — it
 * lives in the server-side layout guards (see issue #984). These tests pin
 * down that nothing is redirected/rewritten beyond the session redirects.
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
  it("does not gate auth: an unauthenticated protected path passes through untouched", async () => {
    // Auth is handled by the server-side layout guards, not the proxy (#984).
    const res = await proxy(makeRequest("/all"));
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("x-middleware-rewrite")).toBeNull();
  });

  it.each(["GET", "POST", "OPTIONS"])(
    "%s /register is never rewritten — DCR lives only at /oauth/register",
    async (method) => {
      const res = await proxy(makeRequest("/register", method));
      expect(res.headers.get("x-middleware-rewrite")).toBeNull();
      expect(res.headers.get("location")).toBeNull();
    }
  );
});

describe("proxy request logging (LOG_MCP_REQUESTS)", () => {
  afterEach(() => {
    delete process.env.LOG_MCP_REQUESTS;
    vi.restoreAllMocks();
  });

  it("logs nothing when LOG_MCP_REQUESTS is unset", async () => {
    delete process.env.LOG_MCP_REQUESTS;
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await proxy(makeRequest("/mcp", "POST"));
    expect(spy).not.toHaveBeenCalled();
  });

  it("logs a structured line with host/method/path and hasAuthorization boolean", async () => {
    process.env.LOG_MCP_REQUESTS = "true";
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await proxy(makeRequest("/mcp", "POST", { authorization: "Bearer super-secret-token" }));
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

  it("reports hasAuthorization=false when no Authorization header is present", async () => {
    process.env.LOG_MCP_REQUESTS = "true";
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await proxy(makeRequest("/mcp", "POST"));
    const entry = JSON.parse(spy.mock.calls[0][0] as string);
    expect(entry.hasAuthorization).toBe(false);
  });

  it("does NOT log ordinary (non-surface) traffic even when enabled", async () => {
    process.env.LOG_MCP_REQUESTS = "true";
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await proxy(makeRequest("/all"));
    await proxy(makeRequest("/api/trpc/entries.list"));
    expect(spy).not.toHaveBeenCalled();
  });

  it("logs probes to the unserved root OAuth paths (misbehaving-connector diagnostics)", async () => {
    // /register, /authorize, /token, /mcp are 404s now, but misbehaving
    // connectors (claude.ai) probe them instead of the advertised endpoints —
    // the logged 404 is the evidence that identifies that failure mode.
    process.env.LOG_MCP_REQUESTS = "true";
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await proxy(makeRequest("/authorize", "GET"));
    expect(spy).toHaveBeenCalledOnce();
  });

  it("logs POST /register (a misplaced DCR attempt) but not GET (the signup page)", async () => {
    process.env.LOG_MCP_REQUESTS = "true";
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await proxy(makeRequest("/register", "GET"));
    expect(spy).not.toHaveBeenCalled();
    await proxy(makeRequest("/register", "POST"));
    expect(spy).toHaveBeenCalledOnce();
  });

  it("redacts sensitive query params (auth code) but keeps public ones", async () => {
    process.env.LOG_MCP_REQUESTS = "true";
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await proxy(makeRequest("/oauth/authorize?client_id=abc&code=SECRET_CODE&state=xyz", "GET"));
    const entry = JSON.parse(spy.mock.calls[0][0] as string);
    const query = new URLSearchParams(entry.query);
    expect(query.get("client_id")).toBe("abc");
    expect(query.get("state")).toBe("xyz");
    expect(query.get("code")).toBe("[redacted]");
    expect(spy.mock.calls[0][0]).not.toContain("SECRET_CODE");
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
  const DYNAMIC_PATHS = ["/all", "/auth/oauth/complete", "/settings", "/api/trpc/entries.list"];

  it.each(PUBLIC_PATHS)("%s gets the relaxed static CSP with no nonce", async (path) => {
    const res = await proxy(makeRequest(path));
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

  it.each(DYNAMIC_PATHS)("%s gets the strict nonce'd CSP", async (path) => {
    const res = await proxy(makeRequest(path));
    const csp = res.headers.get("Content-Security-Policy")!;
    expect(csp).toMatch(/script-src[^;]*'nonce-[A-Za-z0-9+/=_-]+'/);
    expect(csp).toContain("'strict-dynamic'");
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
  });

  it.each(["GET", "POST", "OPTIONS"])(
    "%s /register gets the relaxed static CSP (no route handler exists; a non-GET is a bodyless 405)",
    async (method) => {
      const res = await proxy(makeRequest("/register", method));
      expect(res.headers.get("Content-Security-Policy")).toMatch(/script-src[^;]*'unsafe-inline'/);
      expect(res.headers.get("Content-Security-Policy")).not.toContain("'nonce-");
      expect(res.headers.get("x-middleware-rewrite")).toBeNull();
    }
  );

  it("does not treat demo-prefixed lookalike paths as public", async () => {
    const res = await proxy(makeRequest("/demonstration"));
    expect(res.headers.get("Content-Security-Policy")).toContain("'nonce-");
  });
});

describe("proxy CSP: the analytics beacon", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("allows the beacon destination on BOTH policy tiers when configured", async () => {
    vi.stubEnv("NEXT_PUBLIC_GOATCOUNTER_URL", "https://lionreader.goatcounter.com/count");
    for (const path of ["/privacy", "/all"]) {
      const csp = (await proxy(makeRequest(path))).headers.get("Content-Security-Policy")!;
      expect(csp).toMatch(/connect-src[^;]*https:\/\/lionreader\.goatcounter\.com/);
    }
  });

  it("never adds a third-party script origin — we load no third-party script", async () => {
    vi.stubEnv("NEXT_PUBLIC_GOATCOUNTER_URL", "https://lionreader.goatcounter.com/count");
    for (const path of ["/privacy", "/all"]) {
      const csp = (await proxy(makeRequest(path))).headers.get("Content-Security-Policy")!;
      const scriptSrc = csp.split(";").find((d) => d.trim().startsWith("script-src"))!;
      expect(scriptSrc).not.toContain("goatcounter");
      expect(scriptSrc).not.toContain("zgo.at");
    }
  });

  it("allows nothing extra when analytics is unconfigured", async () => {
    vi.stubEnv("NEXT_PUBLIC_GOATCOUNTER_URL", "");
    const csp = (await proxy(makeRequest("/privacy"))).headers.get("Content-Security-Policy")!;
    expect(csp).not.toContain("goatcounter");
  });

  it("allows nothing extra when the configured URL is malformed", async () => {
    // The beacon and its CSP entry resolve through the same parse, so a bad
    // value must disable both together rather than ship one without the other.
    vi.stubEnv("NEXT_PUBLIC_GOATCOUNTER_URL", "not a url");
    const csp = (await proxy(makeRequest("/privacy"))).headers.get("Content-Security-Policy")!;
    expect(csp).not.toContain("goatcounter");
  });
});

describe("proxy session redirects (issue #1359)", () => {
  it("GET / without a session cookie 307s straight to the demo landing page", async () => {
    const res = await proxy(makeRequest("/"));
    expect(res.status).toBe(307);
    const location = new URL(res.headers.get("location")!);
    expect(location.pathname).toBe("/demo/all");
    expect(location.searchParams.get("entry")).toBe("welcome");
  });

  it("GET /login and /register without a session cookie fall through to the page", async () => {
    for (const path of ["/login", "/register"]) {
      const res = await proxy(makeRequest(path));
      expect(res.status, path).toBe(200);
      expect(res.headers.get("location"), path).toBeNull();
    }
  });

  // The cookie-present validation paths (valid session → /all or
  // /complete-signup; invalid → fall through) need a real database + Redis, so
  // they're covered by tests/e2e/auth-ssr.spec.ts rather than mocked here.
});

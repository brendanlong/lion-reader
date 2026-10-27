/**
 * Unit tests for the Next.js proxy (middleware).
 *
 * The proxy handles session redirects and CSP tiering. Route authentication is
 * deliberately NOT handled here — it lives in the server-side layout guards
 * (see issue #984). These tests pin down that nothing is redirected/rewritten
 * beyond the session redirects.
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect, vi, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "../../src/proxy";
import { SENTRY_TUNNEL_ROUTE } from "../../src/lib/sentry/tunnel-route";

function makeRequest(
  path: string,
  method = "GET",
  headers: Record<string, string> = {}
): NextRequest {
  // Real requests always carry a Host header; NextRequest doesn't derive one from
  // the URL, so set it explicitly to match the origin.
  return new NextRequest(new URL(`https://reader.example.com${path}`), {
    method,
    headers: { host: "reader.example.com", ...headers },
  });
}

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
    // An unauthenticated protected path passes through untouched: auth is the
    // server-side layout guards' job, not the proxy's (#984).
    "/all",
    "/auth/oauth/complete",
    "/settings",
    "/api/trpc/entries.list",
    // The OAuth/MCP surface: nothing here may be rewritten or redirected, or
    // discovery breaks for every remote MCP client.
    "/api/mcp",
    "/oauth/authorize",
    "/.well-known/oauth-protected-resource/api/mcp",
  ];

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

  it.each(DYNAMIC_PATHS)("%s gets the strict nonce'd CSP, unrewritten", async (path) => {
    const res = await proxy(makeRequest(path));
    expect(res.headers.get("x-middleware-rewrite"), path).toBeNull();
    expect(res.headers.get("location"), path).toBeNull();
    const csp = res.headers.get("Content-Security-Policy")!;
    expect(csp).toMatch(/script-src[^;]*'nonce-[A-Za-z0-9+/=_-]+'/);
    expect(csp).toContain("'strict-dynamic'");
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
  });

  it.each(["GET", "OPTIONS"])(
    "%s /register is never rewritten (DCR lives only at /oauth/register) and gets the relaxed static CSP",
    async (method) => {
      const res = await proxy(makeRequest("/register", method));
      expect(res.headers.get("Content-Security-Policy")).toMatch(/script-src[^;]*'unsafe-inline'/);
      expect(res.headers.get("Content-Security-Policy")).not.toContain("'nonce-");
      expect(res.headers.get("x-middleware-rewrite")).toBeNull();
      expect(res.headers.get("location")).toBeNull();
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

/** URL paths of every App Router route handler exporting POST, with dynamic segments filled in. */
function postRouteHandlerPaths(): string[] {
  const appDir = path.join(__dirname, "../../src/app");
  return readdirSync(appDir, { recursive: true, encoding: "utf8" })
    .filter((file) => path.basename(file) === "route.ts")
    .filter((file) =>
      /export\s+(async\s+)?(function|const)\s+POST\b|export\s*\{[^}]*\bPOST\b/.test(
        readFileSync(path.join(appDir, file), "utf8")
      )
    )
    .map(
      (file) =>
        "/" +
        path
          .dirname(file)
          .split(path.sep)
          .filter((segment) => !/^\(.*\)$/.test(segment))
          .map((segment) => (segment.startsWith("[") ? "x" : segment))
          .join("/")
    );
}

describe("proxy rejects server function calls", () => {
  it.each([
    ["a fetch-style call", "/app", { "next-action": "7f00", "content-type": "text/plain" }],
    [
      "a header-less multipart form POST",
      "/all",
      { "content-type": "multipart/form-data; boundary=x" },
    ],
    [
      "a header-less urlencoded form POST",
      "/settings",
      { "content-type": "application/x-www-form-urlencoded" },
    ],
    ["a POST to a static page", "/register", {}],
    ["a POST to the root", "/", { "next-action": "7f00" }],
  ])("405s %s", async (_label, pathname, headers) => {
    const res = await proxy(makeRequest(pathname, "POST", headers));
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET, HEAD");
  });

  it("finds the POST route handlers it checks", () => {
    expect(postRouteHandlerPaths()).toContain("/api/share");
  });

  it.each([...postRouteHandlerPaths(), SENTRY_TUNNEL_ROUTE])(
    "passes POST %s through",
    async (pathname) => {
      const res = await proxy(
        makeRequest(pathname, "POST", { "content-type": "multipart/form-data; boundary=x" })
      );
      expect(res.status).not.toBe(405);
    }
  );
});

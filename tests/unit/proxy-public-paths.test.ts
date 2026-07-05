/**
 * Unit tests for the proxy's public-path matching.
 *
 * See issue #984: `isPublicPath("/")` was treated as a directory prefix, so it
 * matched every path and disabled the proxy auth gate entirely. These tests pin
 * down which routes are public (no session cookie required) vs. protected.
 */

import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { isPublicPath, proxy } from "../../src/proxy";

function makeRequest(
  path: string,
  { method = "GET", session }: { method?: string; session?: string } = {}
): NextRequest {
  const headers = new Headers();
  if (session) {
    headers.set("cookie", `session=${session}`);
  }
  return new NextRequest(new URL(`https://reader.example.com${path}`), { method, headers });
}

describe("isPublicPath", () => {
  it("treats the landing page as an exact match, not a prefix", () => {
    expect(isPublicPath("/")).toBe(true);
    // The bug: "/" ends with "/" and every path starts with "/", so a naive
    // prefix rule would make these public and defeat the auth gate.
    expect(isPublicPath("/all")).toBe(false);
    expect(isPublicPath("/settings")).toBe(false);
    expect(isPublicPath("/starred")).toBe(false);
  });

  it.each([
    "/all",
    "/starred",
    "/saved",
    "/recently-read",
    "/uncategorized",
    "/subscribe",
    "/subscription/123",
    "/tag/abc",
    "/settings",
    "/settings/appearance",
    "/settings/sessions",
    "/complete-signup",
  ])("protects app route %s", (pathname) => {
    expect(isPublicPath(pathname)).toBe(false);
  });

  it.each([
    "/login",
    "/register",
    "/auth/oauth/callback",
    "/auth/oauth/complete",
    "/privacy",
    "/terms",
    "/monitoring",
  ])("allows public page %s", (pathname) => {
    expect(isPublicPath(pathname)).toBe(true);
  });

  it.each([
    "/authorize",
    "/token",
    "/oauth/authorize",
    "/oauth/consent",
    "/oauth/register",
    "/oauth/token",
    "/.well-known/oauth-authorization-server",
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-protected-resource/api/mcp",
  ])("allows OAuth/MCP endpoint %s", (pathname) => {
    expect(isPublicPath(pathname)).toBe(true);
  });

  it.each([
    "/api/trpc/entries.list",
    "/api/mcp",
    "/api/v1/events",
    "/_next/static/chunk.js",
    "/extension/save",
    "/extension/callback",
    "/onnx/model.wasm",
  ])("allows infrastructure/prefix path %s", (pathname) => {
    expect(isPublicPath(pathname)).toBe(true);
  });

  it.each(["/demo", "/demo/all", "/demo/highlights", "/demo/subscription/1"])(
    "allows demo route %s",
    (pathname) => {
      expect(isPublicPath(pathname)).toBe(true);
    }
  );

  it.each(["/admin", "/admin/feeds", "/admin/invites", "/admin/users"])(
    "allows admin route %s (admin has its own session cookie)",
    (pathname) => {
      expect(isPublicPath(pathname)).toBe(true);
    }
  );

  it.each(["/save", "/favicon.ico", "/robots.txt", "/manifest.json", "/sw.js"])(
    "allows static/utility path %s",
    (pathname) => {
      expect(isPublicPath(pathname)).toBe(true);
    }
  );

  it("does not treat a non-directory public path as a prefix", () => {
    // "/save" is exact-match; "/saved" must not be swept in as public.
    expect(isPublicPath("/saved")).toBe(false);
    // "/terms-and-conditions" is not "/terms".
    expect(isPublicPath("/terms-and-conditions")).toBe(false);
  });
});

describe("proxy", () => {
  it("redirects an unauthenticated request for a protected path to /login", () => {
    // This is the behavior the #984 fix restores: before it, the gate never fired.
    const res = proxy(makeRequest("/settings/appearance"));
    expect(res.status).toBe(307);
    const location = new URL(res.headers.get("location")!);
    expect(location.pathname).toBe("/login");
    // The original path (with query) is preserved so the user lands back where they were.
    expect(location.searchParams.get("redirect")).toBe("/settings/appearance");
  });

  it("preserves query params of the original protected URL in the redirect param", () => {
    const res = proxy(makeRequest("/subscription/123?filter=unread"));
    expect(res.status).toBe(307);
    const location = new URL(res.headers.get("location")!);
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("redirect")).toBe("/subscription/123?filter=unread");
  });

  it("lets an authenticated request for a protected path through", () => {
    const res = proxy(makeRequest("/all", { session: "some-token" }));
    // NextResponse.next() has no redirect location.
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("x-middleware-rewrite")).toBeNull();
  });

  it("lets an unauthenticated request for a public path through", () => {
    const res = proxy(makeRequest("/demo/all"));
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("x-middleware-rewrite")).toBeNull();
  });

  it("does not redirect the OAuth /token endpoint (POSTed server-to-server, no session)", () => {
    const res = proxy(makeRequest("/token", { method: "POST" }));
    expect(res.headers.get("location")).toBeNull();
  });

  it.each(["POST", "OPTIONS"])(
    "rewrites %s /register to the OAuth DCR handler at /oauth/register",
    (method) => {
      const res = proxy(makeRequest("/register", { method }));
      const rewrite = new URL(res.headers.get("x-middleware-rewrite")!);
      expect(rewrite.pathname).toBe("/oauth/register");
      expect(res.headers.get("location")).toBeNull();
    }
  );

  it("does not rewrite GET /register (the human signup page)", () => {
    const res = proxy(makeRequest("/register"));
    expect(res.headers.get("x-middleware-rewrite")).toBeNull();
    // /register is public, so no redirect either.
    expect(res.headers.get("location")).toBeNull();
  });
});

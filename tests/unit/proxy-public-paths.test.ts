/**
 * Unit tests for the proxy's public-path matching.
 *
 * See issue #984: `isPublicPath("/")` was treated as a directory prefix, so it
 * matched every path and disabled the proxy auth gate entirely. These tests pin
 * down which routes are public (no session cookie required) vs. protected.
 */

import { describe, it, expect } from "vitest";
import { isPublicPath } from "../../src/proxy";

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

  it.each(["/demo", "/demo/all", "/demo/articles", "/demo/subscription/1"])(
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

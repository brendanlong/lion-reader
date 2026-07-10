/**
 * Unit tests for OAuth/MCP trailing-slash normalization (applied to req.url in
 * scripts/server.ts before Next.js routing).
 *
 * The OAuth/MCP surface must answer slashed URLs in place — server-to-server
 * OAuth clients (claude.ai uses python-httpx) don't follow redirects on POST,
 * and claude.ai has been observed appending trailing slashes
 * (anthropics/claude-ai-mcp#324). Every other path must be returned unchanged
 * so Next's built-in 308 redirect keeps handling it.
 */

import { describe, it, expect } from "vitest";
import { stripOauthSurfaceTrailingSlash } from "../../src/server/http/trailing-slash";

describe("stripOauthSurfaceTrailingSlash", () => {
  it.each([
    ["/api/mcp/", "/api/mcp"],
    ["/token/", "/token"],
    ["/authorize/", "/authorize"],
    ["/oauth/token/", "/oauth/token"],
    ["/oauth/authorize/", "/oauth/authorize"],
    ["/oauth/register/", "/oauth/register"],
    ["/oauth/revoke/", "/oauth/revoke"],
    ["/.well-known/oauth-authorization-server/", "/.well-known/oauth-authorization-server"],
    [
      "/.well-known/oauth-protected-resource/api/mcp/",
      "/.well-known/oauth-protected-resource/api/mcp",
    ],
  ])("strips %s to %s", (slashed, expected) => {
    expect(stripOauthSurfaceTrailingSlash(slashed)).toBe(expected);
  });

  it("collapses repeated trailing slashes", () => {
    expect(stripOauthSurfaceTrailingSlash("/api/mcp///")).toBe("/api/mcp");
  });

  it("preserves the query string", () => {
    expect(stripOauthSurfaceTrailingSlash("/oauth/authorize/?client_id=abc&state=x%2Fy")).toBe(
      "/oauth/authorize?client_id=abc&state=x%2Fy"
    );
  });

  it.each([
    // Non-surface paths keep Next's built-in 308 redirect
    "/all/",
    "/register/", // the signup page redirects like any other page URL
    "/settings/appearance/",
    "/nonexistent/",
    // Slashless URLs are untouched
    "/api/mcp",
    "/oauth/token",
    "/all",
    // Root and degenerate paths
    "/",
    "//",
    // A query-only trailing slash is not a path trailing slash
    "/api/mcp?foo=bar/",
    // Encoded slashes never trigger normalization (raw URL is not decoded)
    "/api/mcp%2F",
    "/foo%2Fapi/mcp/",
  ])("returns %s unchanged", (url) => {
    expect(stripOauthSurfaceTrailingSlash(url)).toBe(url);
  });

  it("does not treat a surface prefix with extra segments as the endpoint", () => {
    // /api/mcp/extra/ trims to /api/mcp/extra, which is not a surface path
    expect(stripOauthSurfaceTrailingSlash("/api/mcp/extra/")).toBe("/api/mcp/extra/");
  });
});

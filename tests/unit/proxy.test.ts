/**
 * Unit tests for the Next.js proxy (middleware).
 *
 * The proxy's only job is the claude.ai OAuth workaround: rewriting POST/OPTIONS
 * `/register` to the Dynamic Client Registration handler at `/oauth/register`.
 * Route authentication is deliberately NOT handled here — it lives in the
 * server-side layout guards (see issue #984). These tests pin down the rewrite
 * behavior and that nothing else is redirected/rewritten.
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

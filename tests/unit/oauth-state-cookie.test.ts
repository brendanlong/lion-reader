import { describe, it, expect } from "vitest";
import {
  setOAuthStateCookie,
  oauthStateCookieMatches,
  OAUTH_STATE_COOKIE_NAME,
} from "@/server/auth/oauth/state-cookie";

describe("oauthStateCookieMatches", () => {
  it("accepts a cookie that equals the callback state", () => {
    expect(oauthStateCookieMatches("abc123", "abc123")).toBe(true);
  });

  it("rejects a mismatched cookie (attacker-supplied state)", () => {
    expect(oauthStateCookieMatches("victim-state", "attacker-state")).toBe(false);
  });

  it("fails closed when the cookie is missing", () => {
    // The core login-CSRF case: the victim never started a flow, so has no cookie.
    expect(oauthStateCookieMatches(null, "attacker-state")).toBe(false);
  });

  it("fails closed on an empty cookie value", () => {
    expect(oauthStateCookieMatches("", "")).toBe(false);
  });
});

describe("setOAuthStateCookie", () => {
  it("no-ops without resHeaders (REST/OpenAPI path — no browser to bind)", () => {
    // Should not throw.
    expect(() => setOAuthStateCookie(undefined, "state-value")).not.toThrow();
  });

  it("sets an HttpOnly, SameSite=Lax cookie for GET-redirect providers", () => {
    const headers = new Headers();
    setOAuthStateCookie(headers, "state-value");
    const cookie = headers.get("Set-Cookie");
    expect(cookie).toContain(`${OAUTH_STATE_COOKIE_NAME}=state-value`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Max-Age=600");
    expect(cookie).toContain("Path=/");
  });

  it("uses SameSite=None; Secure for Apple's cross-site form_post callback", () => {
    const headers = new Headers();
    setOAuthStateCookie(headers, "state-value", "none");
    const cookie = headers.get("Set-Cookie");
    expect(cookie).toContain("SameSite=None");
    // SameSite=None is only valid when Secure, regardless of environment.
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("HttpOnly");
  });
});
